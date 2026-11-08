// Package wgtunnel is Burrow's own WireGuard: wireguard-go in userspace
// over a netstack, inside the app's process. No VPN service, so it works
// next to another VPN, and only Burrow's own traffic goes through it.
//
// Traffic reaches it through a small HTTP proxy on 127.0.0.1 (the WebView
// takes a proxy; the direct route's SSH does CONNECT). Any app on the phone
// can reach a local port, so the proxy asks for a secret that only Burrow
// knows (Proxy-Authorization), and it goes only to addresses the peer's
// AllowedIPs cover.
package wgtunnel

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Realm of the proxy's 407: the app answers only this one.
const Realm = "burrow-wireguard"

// Tunnel is one running WireGuard interface with its proxy.
type Tunnel struct {
	dev     *device.Device
	tnet    *netstack.Net
	ln      net.Listener
	auth    string
	allowed []netip.Prefix
	dns     bool
	wg      sync.WaitGroup
	// Connections not signed in yet: at most cap(pending) at once, the rest closed at once.
	pending chan struct{}
	mu      sync.Mutex
	refusal string
}

// Before the secret is shown: so many connections at once, so many header bytes each. Another app
// on the phone could open sockets without end, each a goroutine reading headers (AUDIT2 AND-14).
const (
	maxPending = 32
	maxHeader  = 64 << 10
)

// config is what a wg-quick file says, the parts Burrow uses.
type config struct {
	PrivateKey string
	Addresses  []netip.Prefix
	DNS        []netip.Addr
	MTU        int
	Peers      []peer
}

type peer struct {
	PublicKey    string
	PresharedKey string
	Endpoint     string
	AllowedIPs   []netip.Prefix
	Keepalive    int
}

// parseConfig reads a wg-quick configuration ([Interface] and [Peer]).
func parseConfig(text string) (*config, error) {
	c := &config{MTU: 1420}
	var cur *peer
	section := ""
	for n, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(strings.Trim(line, "[] "))
			if section == "peer" {
				c.Peers = append(c.Peers, peer{})
				cur = &c.Peers[len(c.Peers)-1]
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected key = value", n+1)
		}
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)
		list := func() []string {
			var out []string
			for _, p := range strings.Split(v, ",") {
				if p = strings.TrimSpace(p); p != "" {
					out = append(out, p)
				}
			}
			return out
		}
		switch {
		case section == "interface" && k == "privatekey":
			c.PrivateKey = v
		case section == "interface" && k == "address":
			for _, a := range list() {
				p, err := netip.ParsePrefix(a)
				if err != nil {
					addr, err2 := netip.ParseAddr(a)
					if err2 != nil {
						return nil, fmt.Errorf("line %d: address %q", n+1, a)
					}
					p = netip.PrefixFrom(addr, addr.BitLen())
				}
				c.Addresses = append(c.Addresses, p)
			}
		case section == "interface" && k == "dns":
			for _, a := range list() {
				if addr, err := netip.ParseAddr(a); err == nil {
					c.DNS = append(c.DNS, addr)
				}
			}
		case section == "interface" && k == "mtu":
			m, err := strconv.Atoi(v)
			if err != nil || m < 576 || m > 9000 {
				return nil, fmt.Errorf("line %d: mtu %q", n+1, v)
			}
			c.MTU = m
		case section == "peer" && cur != nil && k == "publickey":
			cur.PublicKey = v
		case section == "peer" && cur != nil && k == "presharedkey":
			cur.PresharedKey = v
		case section == "peer" && cur != nil && k == "endpoint":
			cur.Endpoint = v
		case section == "peer" && cur != nil && k == "allowedips":
			for _, a := range list() {
				p, err := netip.ParsePrefix(a)
				if err != nil {
					return nil, fmt.Errorf("line %d: allowed ip %q", n+1, a)
				}
				cur.AllowedIPs = append(cur.AllowedIPs, p.Masked())
			}
		case section == "peer" && cur != nil && k == "persistentkeepalive":
			cur.Keepalive, _ = strconv.Atoi(v)
		}
	}
	if c.PrivateKey == "" || len(c.Addresses) == 0 || len(c.Peers) == 0 {
		return nil, errors.New("a WireGuard configuration needs a PrivateKey, an Address and a [Peer]")
	}
	for _, p := range c.Peers {
		if p.PublicKey == "" || p.Endpoint == "" || len(p.AllowedIPs) == 0 {
			return nil, errors.New("each [Peer] needs a PublicKey, an Endpoint and AllowedIPs")
		}
	}
	return c, nil
}

func keyHex(b64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(b) != 32 {
		return "", errors.New("not a WireGuard key")
	}
	return hex.EncodeToString(b), nil
}

// uapi turns the configuration into wireguard-go's settings.
func (c *config) uapi() (string, error) {
	var b strings.Builder
	k, err := keyHex(c.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("PrivateKey: %w", err)
	}
	fmt.Fprintf(&b, "private_key=%s\n", k)
	for _, p := range c.Peers {
		pk, err := keyHex(p.PublicKey)
		if err != nil {
			return "", fmt.Errorf("PublicKey: %w", err)
		}
		fmt.Fprintf(&b, "public_key=%s\n", pk)
		if p.PresharedKey != "" {
			psk, err := keyHex(p.PresharedKey)
			if err != nil {
				return "", fmt.Errorf("PresharedKey: %w", err)
			}
			fmt.Fprintf(&b, "preshared_key=%s\n", psk)
		}
		ep, err := net.ResolveUDPAddr("udp", p.Endpoint)
		if err != nil {
			return "", fmt.Errorf("Endpoint %s: %w", p.Endpoint, err)
		}
		fmt.Fprintf(&b, "endpoint=%s\n", ep.String())
		if p.Keepalive > 0 {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.Keepalive)
		}
		for _, a := range p.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", a.String())
		}
	}
	return b.String(), nil
}

// Check says what is wrong with a configuration ("" when it is fine), for
// the import screen.
func Check(conf string) string {
	c, err := parseConfig(conf)
	if err == nil {
		_, err = c.uapi()
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

// Start brings the tunnel up and its proxy on 127.0.0.1 (a free port).
// user and secret are what the proxy asks for.
func Start(conf, user, secret string) (*Tunnel, error) {
	c, err := parseConfig(conf)
	if err != nil {
		return nil, err
	}
	settings, err := c.uapi()
	if err != nil {
		return nil, err
	}
	addrs := make([]netip.Addr, 0, len(c.Addresses))
	for _, a := range c.Addresses {
		addrs = append(addrs, a.Addr())
	}
	tunDev, tnet, err := netstack.CreateNetTUN(addrs, c.DNS, c.MTU)
	if err != nil {
		return nil, err
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg: "))
	if err := dev.IpcSet(settings); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		dev.Close()
		return nil, err
	}
	t := &Tunnel{dev: dev, tnet: tnet, ln: ln, auth: "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+secret)), dns: len(c.DNS) > 0, pending: make(chan struct{}, maxPending)}
	for _, p := range c.Peers {
		t.allowed = append(t.allowed, p.AllowedIPs...)
	}
	t.wg.Add(1)
	go t.serve()
	return t, nil
}

// Port is the proxy's port on 127.0.0.1.
func (t *Tunnel) Port() int { return t.ln.Addr().(*net.TCPAddr).Port }

// LastHandshake is the newest handshake with any peer, in Unix seconds (0: none yet).
func (t *Tunnel) LastHandshake() int64 {
	s, err := t.dev.IpcGet()
	if err != nil {
		return 0
	}
	var last int64
	for _, line := range strings.Split(s, "\n") {
		if v, ok := strings.CutPrefix(line, "last_handshake_time_sec="); ok {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > last {
				last = n
			}
		}
	}
	return last
}

// Rebind opens the tunnel's UDP socket anew: after the phone changed network
// (Wi-Fi to mobile data) the old one can hold an address that is gone, and
// the peer heard nothing more until the tunnel was started again.
func (t *Tunnel) Rebind() error { return t.dev.BindUpdate() }

// Stop closes the proxy and the tunnel.
func (t *Tunnel) Stop() {
	_ = t.ln.Close()
	t.dev.Close()
	t.wg.Wait()
}

func (t *Tunnel) serve() {
	defer t.wg.Done()
	for {
		c, err := t.ln.Accept()
		if err != nil {
			return
		}
		select {
		case t.pending <- struct{}{}:
			go t.handle(c)
		default:
			_ = c.Close()
		}
	}
}

// resolve turns host into an address the peers' AllowedIPs cover. A name
// is asked of the tunnel's own DNS only (the configuration's DNS = line).
// Never of the phone's: on a network someone else runs (an open Wi-Fi), that
// DNS picks the address, and a full tunnel (AllowedIPs = 0.0.0.0/0) covers
// any, so a plain-http app tab with its cookies went where it said. When the
// tunnel's DNS does not answer, or there is none, the request fails and says
// why (A3-AND-01).
func (t *Tunnel) resolve(ctx context.Context, host string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap(), nil
	}
	if !t.dns {
		return netip.Addr{}, fmt.Errorf("%s: a name needs the tunnel's own DNS (a DNS = line in the WireGuard configuration); the phone's own DNS is not asked, use an address instead", host)
	}
	addrs, err := t.tnet.LookupContextHost(ctx, host)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("%s: not found by the tunnel's DNS (%v); the phone's own DNS is not asked", host, err)
	}
	for _, s := range addrs {
		if a, err := netip.ParseAddr(s); err == nil && t.covers(a.Unmap()) {
			return a.Unmap(), nil
		}
	}
	return netip.Addr{}, fmt.Errorf("%s is not in the tunnel's networks", host)
}

func (t *Tunnel) covers(a netip.Addr) bool {
	for _, p := range t.allowed {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func (t *Tunnel) dial(ctx context.Context, hostport string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return nil, err
	}
	a, err := t.resolve(ctx, host)
	if err == nil && !t.covers(a) {
		err = fmt.Errorf("%s is not in the tunnel's networks", a)
	}
	if err != nil {
		t.refused(err)
		return nil, err
	}
	return t.tnet.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), port))
}

// refused keeps why the proxy last turned a request down, for the app's error screens.
func (t *Tunnel) refused(err error) {
	t.mu.Lock()
	t.refusal = err.Error()
	t.mu.Unlock()
}

// LastRefusal says why the proxy last turned a request down ("" when none
// has been): a name its DNS did not find, an address outside AllowedIPs.
func (t *Tunnel) LastRefusal() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.refusal
}

// badGateway answers a request the tunnel could not carry, with why in the
// status line and a short page: the app's own sockets and the WebView show it.
func badGateway(c net.Conn, err error) {
	why := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return ' '
		}
		return r
	}, err.Error())
	if len(why) > 300 {
		why = why[:300]
	}
	body := "Burrow's WireGuard: " + why + "\n"
	_, _ = io.WriteString(c, "HTTP/1.1 502 "+why+"\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\nConnection: close\r\n\r\n"+body)
}

// withPort is the authority with a port: the default when it has none, an
// IPv6 address in brackets. Looking for a colon took "[fd00::5]" for one
// with a port, and dialing it failed (AUDIT2 AND-16).
func withPort(authority, def string) string {
	if _, _, err := net.SplitHostPort(authority); err == nil {
		return authority
	}
	return net.JoinHostPort(strings.TrimSuffix(strings.TrimPrefix(authority, "["), "]"), def)
}

func (t *Tunnel) handle(c net.Conn) {
	defer c.Close()
	admitted := true
	release := func() {
		if admitted {
			admitted = false
			<-t.pending
		}
	}
	defer release()
	// Not long: a local app holding the few places open with idle sockets shut out Burrow's own (audit 2026-11-05).
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	lr := &io.LimitedReader{R: c, N: maxHeader}
	br := bufio.NewReader(lr)
	// Without the secret: 407, and the connection stays open for the same
	// request with it. Android's own HTTP client asks again on the same
	// socket after a 407 to CONNECT (closed, its update download failed with
	// "unexpected end of stream on null"). A few tries at most.
	var req *http.Request
	for try := 0; ; try++ {
		r, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(t.auth)) == 1 {
			req = r
			// Signed in: no header limit for what it sends now, and its place free for another.
			lr.N = math.MaxInt64
			release()
			break
		}
		// Whatever body came with it, read and dropped, so the next request starts clean.
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
		r.Body.Close()
		if try >= 2 {
			_, _ = io.WriteString(c, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\""+Realm+"\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
			return
		}
		_, _ = io.WriteString(c, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\""+Realm+"\"\r\nContent-Length: 0\r\n\r\n")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if req.Method == http.MethodConnect {
		up, err := t.dial(ctx, req.Host)
		if err != nil {
			badGateway(c, err)
			return
		}
		defer up.Close()
		_ = c.SetReadDeadline(time.Time{})
		_, _ = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
		pipe(c, br, up)
		return
	}
	// Plain http: forward the request as is, over one connection.
	up, err := t.dial(ctx, withPort(req.Host, "80"))
	if err != nil {
		badGateway(c, err)
		return
	}
	defer up.Close()
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Proxy-Connection")
	// One request per connection: the browser reuses a proxy connection for
	// other hosts, which must not end up at this one.
	req.Close = true
	req.Header.Set("Connection", "close")
	req.RequestURI = ""
	_ = c.SetReadDeadline(time.Time{})
	if err := req.Write(up); err != nil {
		return
	}
	pipe(c, br, up)
}

func pipe(c net.Conn, br *bufio.Reader, up net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(up, br)
		if tc, ok := up.(interface{ CloseWrite() error }); ok {
			_ = tc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(c, up)
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
}
