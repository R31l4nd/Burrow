package wgtunnel

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// linked is the phone's side of a tunnel (10.99.0.2, its DNS 10.99.0.1)
// wired straight to a far side (10.99.0.1) without WireGuard: what the
// proxy does with names, addresses and requests, tested without a server.
func linked(t *testing.T) (phone, far *netstack.Net) {
	t.Helper()
	devA, a, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.99.0.2")}, []netip.Addr{netip.MustParseAddr("10.99.0.1")}, 1420)
	if err != nil {
		t.Fatal(err)
	}
	devB, b, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.99.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	pump := func(from, to tun.Device) {
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		for {
			n, err := from.Read(bufs, sizes, 0)
			if err != nil {
				return
			}
			for i := 0; i < n; i++ {
				if _, err := to.Write([][]byte{bufs[i][:sizes[i]]}, 0); err != nil && !errors.Is(err, net.ErrClosed) {
					return
				}
			}
		}
	}
	go pump(devA, devB)
	go pump(devB, devA)
	t.Cleanup(func() { _ = devA.Close(); _ = devB.Close() })
	return a, b
}

// dnsOn answers A questions on pc from names (a name not in it: no answer
// records), and counts the questions.
func dnsOn(pc net.PacketConn, names map[string][4]byte, asked *atomic.Int32) {
	buf := make([]byte, 512)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if n < 12 {
			continue
		}
		asked.Add(1)
		q := buf[:n]
		var labels []string
		end := 12
		for end < n && q[end] != 0 {
			l := int(q[end])
			if end+1+l > n {
				break
			}
			labels = append(labels, string(q[end+1:end+1+l]))
			end += l + 1
		}
		end += 5
		if end > n {
			continue
		}
		qtype := binary.BigEndian.Uint16(q[end-4 : end-2])
		out := append([]byte{}, q[:end]...)
		out[2], out[3] = 0x81, 0x80
		binary.BigEndian.PutUint16(out[8:10], 0)
		binary.BigEndian.PutUint16(out[10:12], 0)
		addr, ok := names[strings.Join(labels, ".")]
		if qtype == 1 && ok {
			binary.BigEndian.PutUint16(out[6:8], 1)
			out = append(out, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, addr[0], addr[1], addr[2], addr[3])
		} else {
			binary.BigEndian.PutUint16(out[6:8], 0)
		}
		_, _ = pc.WriteTo(out, from)
	}
}

// farSide: the tunnel's DNS on 10.99.0.1:53 and a web page on 10.99.0.1:8080
// that writes down the headers it got. The phone's own DNS is a stand-in
// that counts what it is asked.
type farSide struct {
	tun        *Tunnel
	tunnelDNS  atomic.Int32
	phoneDNS   atomic.Int32
	mu         sync.Mutex
	seen       []http.Header
	secretAuth string
}

func newFarSide(t *testing.T) *farSide {
	t.Helper()
	phone, far := linked(t)
	f := &farSide{secretAuth: "Basic YnVycm93OnMzY3JldA=="}
	pc, err := far.ListenUDPAddrPort(netip.MustParseAddrPort("10.99.0.1:53"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	go dnsOn(pc, map[string][4]byte{"nas.lan": {10, 99, 0, 1}, "outside.lan": {1, 1, 1, 1}}, &f.tunnelDNS)
	web, err := far.ListenTCPAddrPort(netip.MustParseAddrPort("10.99.0.1:8080"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.seen = append(f.seen, r.Header.Clone())
		f.mu.Unlock()
		_, _ = io.WriteString(w, "far side "+r.URL.Path)
	})}
	go func() { _ = srv.Serve(web) }()
	t.Cleanup(func() { _ = srv.Close() })

	// The phone's own DNS, which must never be asked.
	local, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Close() })
	go dnsOn(local, map[string][4]byte{"nas.lan": {192, 0, 2, 66}, "outside.lan": {192, 0, 2, 66}}, &f.phoneDNS)
	saved := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", local.LocalAddr().String())
	}}
	t.Cleanup(func() { net.DefaultResolver = saved })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.tun = &Tunnel{tnet: phone, ln: ln, dns: true, auth: f.secretAuth, allowed: []netip.Prefix{netip.MustParsePrefix("10.99.0.0/24")}}
	f.tun.wg.Add(1)
	go f.tun.serve()
	t.Cleanup(func() { _ = ln.Close(); f.tun.wg.Wait() })
	return f
}

func (f *farSide) client(user *url.Userinfo) *http.Client {
	u := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", f.tun.Port()), User: user}
	return &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u), DisableKeepAlives: true}}
}

// A name goes to the tunnel's own DNS and is used only when its address is
// inside the tunnel's networks; the phone's DNS is never asked (A3-AND-01).
func TestNamesGoToTheTunnelsOwnDNS(t *testing.T) {
	f := newFarSide(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a, err := f.tun.resolve(ctx, "nas.lan")
	if err != nil || a.String() != "10.99.0.1" {
		t.Fatalf("nas.lan: %v %v", a, err)
	}
	if f.tunnelDNS.Load() == 0 {
		t.Error("the tunnel's DNS was not asked")
	}
	// The tunnel's DNS names an address outside the tunnel: refused, not dialled.
	if _, err := f.tun.resolve(ctx, "outside.lan"); err == nil || !strings.Contains(err.Error(), "not in the tunnel's networks") {
		t.Errorf("outside.lan: %v", err)
	}
	if _, err := f.tun.dial(ctx, "outside.lan:80"); err == nil || !strings.Contains(f.tun.LastRefusal(), "outside.lan") {
		t.Errorf("dial outside.lan: %v, refusal %q", err, f.tun.LastRefusal())
	}
	// A name the tunnel's DNS does not know: not found, and said so.
	if _, err := f.tun.resolve(ctx, "gone.lan"); err == nil || !strings.Contains(err.Error(), "not found by the tunnel's DNS") {
		t.Errorf("gone.lan: %v", err)
	}
	if n := f.phoneDNS.Load(); n != 0 {
		t.Errorf("the phone's own DNS was asked %d times", n)
	}
}

// An address, also written as IPv4-mapped IPv6, is checked as the IPv4
// address it is: inside the tunnel's networks it goes, outside it is refused.
func TestMappedAddressesAreCheckedAsIPv4(t *testing.T) {
	f := newFarSide(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := f.tun.dial(ctx, "[::ffff:10.99.0.1]:8080")
	if err != nil {
		t.Fatalf("a mapped address inside: %v", err)
	}
	_ = c.Close()
	for _, out := range []string{"[::ffff:1.1.1.1]:80", "1.1.1.1:80", "[fd00::1]:80", "10.98.0.1:80"} {
		if c, err := f.tun.dial(ctx, out); err == nil {
			_ = c.Close()
			t.Errorf("%s went through", out)
		}
	}
	if _, err := f.tun.dial(ctx, "no-port"); err == nil {
		t.Error("an authority without a port was dialled")
	}
}

// Through the proxy with the secret: the page behind the tunnel, by name;
// the secret and the proxy's own headers stay with the proxy, and every
// request has its own connection.
func TestTheSecretStaysWithTheProxy(t *testing.T) {
	f := newFarSide(t)
	res, err := f.client(url.UserPassword("burrow", "s3cret")).Get("http://nas.lan:8080/page")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "far side /page" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	f.mu.Lock()
	h := f.seen[0]
	f.mu.Unlock()
	if h.Get("Proxy-Authorization") != "" || h.Get("Proxy-Connection") != "" {
		t.Errorf("the proxy's headers went on to the host: %v", h)
	}
	if h.Get("Connection") != "close" {
		t.Errorf("Connection: %q", h.Get("Connection"))
	}
	// Plain http to a host outside the tunnel: a 502 that says why, nothing sent there.
	res, err = f.client(url.UserPassword("burrow", "s3cret")).Get("http://outside.lan/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway || !strings.Contains(res.Status, "outside.lan") {
		t.Errorf("outside: %s", res.Status)
	}
	if n := f.phoneDNS.Load(); n != 0 {
		t.Errorf("the phone's own DNS was asked %d times", n)
	}
}

// Without the secret: 407 twice on the same connection (Android's own client
// answers on it), then a last 407 that closes it; nothing reaches the host.
func TestNoSecretNoWayThrough(t *testing.T) {
	f := newFarSide(t)
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.tun.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	br := bufio.NewReader(c)
	for try := 0; try < 3; try++ {
		auth := ""
		if try == 1 {
			auth = "Proxy-Authorization: Basic YnVycm93Omd1ZXNz\r\n"
		}
		// A body with it is read and dropped: the next request starts clean.
		fmt.Fprintf(c, "POST http://nas.lan:8080/x HTTP/1.1\r\nHost: nas.lan:8080\r\n%sContent-Length: 5\r\n\r\nhello", auth)
		res, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatalf("try %d: %v", try, err)
		}
		if res.StatusCode != http.StatusProxyAuthRequired || !strings.Contains(res.Header.Get("Proxy-Authenticate"), `realm="`+Realm+`"`) {
			t.Fatalf("try %d: %s", try, res.Status)
		}
		if res.Close != (try == 2) {
			t.Errorf("try %d: closing %v", try, res.Close)
		}
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := br.ReadByte(); err != io.EOF {
		t.Errorf("after the third 407 the connection stays open: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.seen) != 0 {
		t.Errorf("a request without the secret reached the host: %v", f.seen)
	}
}

// The 502's reason is one plain line: no line breaks or other control
// characters from an error can start a header of their own; cut at 300.
func TestBadGatewaySaysWhyOnOneLine(t *testing.T) {
	for _, why := range []string{"evil.lan\r\nSet-Cookie: burrow_session=x\r\n", strings.Repeat("x", 1000) + "\n"} {
		client, server := net.Pipe()
		go func() { badGateway(server, errors.New(why)); _ = server.Close() }()
		res, err := http.ReadResponse(bufio.NewReader(client), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = client.Close()
		if res.StatusCode != http.StatusBadGateway || res.Header.Get("Set-Cookie") != "" || len(res.Header) != 2 || !res.Close {
			t.Errorf("%q: %s %v", why, res.Status, res.Header)
		}
		if strings.ContainsAny(res.Status, "\r\n") || len(res.Status) > 4+300 {
			t.Errorf("status line %q", res.Status)
		}
		if !strings.HasPrefix(string(body), "Burrow's WireGuard: ") || strings.Count(string(body), "\n") != 1 {
			t.Errorf("body %q", body)
		}
	}
}

// What a configuration must have, and what is refused with the line it is on.
func TestConfigurationsRefused(t *testing.T) {
	for _, c := range []struct{ bad, want string }{
		{"[Interface]\nPrivateKey\n", "line 2: expected key = value"},
		{"[Interface]\nAddress = 10.0.0.2/33\n", "line 2: address"},
		{"[Interface]\nAddress = nonsense\n", "line 2: address"},
		{"[Interface]\nMTU = 100\n", "line 2: mtu"},
		{"[Interface]\nMTU = big\n", "line 2: mtu"},
		{"[Peer]\nAllowedIPs = 10.0.0.0/40\n", "line 2: allowed ip"},
		{"[Interface]\nPrivateKey = k\nAddress = 10.0.0.2\n[Peer]\nPublicKey = p\n", "each [Peer] needs"},
	} {
		bad, want := c.bad, c.want
		_, err := parseConfig(bad)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", bad, err, want)
		}
		if _, err := Start(bad, "burrow", "s"); err == nil {
			t.Errorf("Start took %q", bad)
		}
	}
	c, err := parseConfig(sample + "\n[Interface]\nMTU = 1280\nDNS = not-an-address, 10.99.0.53\n")
	if err != nil || c.MTU != 1280 || len(c.DNS) != 2 {
		t.Fatalf("%+v %v", c, err)
	}
}

// The keys and the endpoint as wireguard-go takes them; a wrong one says which.
func TestUapiSaysWhichKeyIsWrong(t *testing.T) {
	psk := "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
	withPsk := strings.Replace(sample, "PersistentKeepalive = 25", "PresharedKey = "+psk, 1)
	c, err := parseConfig(withPsk)
	if err != nil {
		t.Fatal(err)
	}
	u, err := c.uapi()
	if err != nil || !strings.Contains(u, "preshared_key=c809f3e5") || strings.Contains(u, "persistent_keepalive") {
		t.Errorf("%v\n%s", err, u)
	}
	for _, c := range []struct{ conf, want string }{
		{strings.Replace(sample, "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=", "c2hvcnQ=", 1), "PrivateKey"},
		{strings.Replace(withPsk, "PresharedKey = "+psk, "PresharedKey = nope", 1), "PresharedKey"},
		{strings.Replace(sample, "127.0.0.1:51899", "127.0.0.1:notaport", 1), "Endpoint"},
	} {
		conf, want := c.conf, c.want
		msg := Check(conf)
		if !strings.Contains(msg, want) {
			t.Errorf("Check said %q, want %q", msg, want)
		}
		if _, err := Start(conf, "burrow", "s"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Start: %v, want %q", err, want)
		}
	}
}
