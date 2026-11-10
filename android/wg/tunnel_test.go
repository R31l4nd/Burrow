package wgtunnel

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun/netstack"
)

const sample = `[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=  # the phone's
Address = 10.99.0.2/32, fd00::2
DNS = 10.99.0.1

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 127.0.0.1:51899
AllowedIPs = 10.99.0.0/24, 192.168.1.0/24
PersistentKeepalive = 25
`

func TestParse(t *testing.T) {
	c, err := parseConfig(sample)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Addresses) != 2 || c.Addresses[1].String() != "fd00::2/128" || len(c.DNS) != 1 || len(c.Peers) != 1 || len(c.Peers[0].AllowedIPs) != 2 || c.Peers[0].Keepalive != 25 {
		t.Fatalf("parsed %+v", c)
	}
	u, err := c.uapi()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"private_key=c809f3e5", "endpoint=127.0.0.1:51899", "allowed_ip=192.168.1.0/24", "persistent_keepalive_interval=25"} {
		if !strings.Contains(u, want) {
			t.Errorf("uapi misses %q:\n%s", want, u)
		}
	}
	if Check(sample) != "" {
		t.Error(Check(sample))
	}
	for _, bad := range []string{"", "[Interface]\nAddress = 10.0.0.2/32", strings.Replace(sample, "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=", "short", 1)} {
		if Check(bad) == "" {
			t.Errorf("accepted %q", bad)
		}
	}
}

// Against a real WireGuard server (android/test/wg-server.sh): its page
// comes through the proxy, only with the secret, only inside AllowedIPs.
func TestTunnel(t *testing.T) {
	conf := os.Getenv("WG_TEST_CONF")
	if conf == "" {
		t.Skip("WG_TEST_CONF not set (android/test/wg-server.sh)")
	}
	tun, err := Start(conf, "burrow", "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Stop()
	proxy := func(user *url.Userinfo) *http.Client {
		u := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", tun.Port()), User: user}
		return &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}}
	}

	// With the secret: the page behind the tunnel.
	res, err := proxy(url.UserPassword("burrow", "s3cret")).Get("http://10.99.0.1:8080/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(body), "hello through the tunnel") {
		t.Fatalf("got %d %q", res.StatusCode, body)
	}
	if tun.LastHandshake() == 0 {
		t.Error("no handshake recorded")
	}

	// A new network (its socket made anew): still through.
	if err := tun.Rebind(); err != nil {
		t.Fatal(err)
	}
	res, err = proxy(url.UserPassword("burrow", "s3cret")).Get("http://10.99.0.1:8080/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	// Without it, or with a wrong one: 407, nothing forwarded.
	for _, u := range []*url.Userinfo{nil, url.UserPassword("burrow", "guess")} {
		res, err := proxy(u).Get("http://10.99.0.1:8080/")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusProxyAuthRequired || !strings.Contains(res.Header.Get("Proxy-Authenticate"), Realm) {
			t.Fatalf("without the secret: %d", res.StatusCode)
		}
	}

	// CONNECT (https, WebSockets, the direct route's SSH) to the same page.
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", tun.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "CONNECT 10.99.0.1:8080 HTTP/1.1\r\nHost: 10.99.0.1:8080\r\nProxy-Authorization: Basic YnVycm93OnMzY3JldA==\r\n\r\n")
	br := bufio.NewReader(c)
	status, _ := br.ReadString('\n')
	if !strings.Contains(status, "200") {
		t.Fatalf("CONNECT: %q", status)
	}
	for line, _ := br.ReadString('\n'); line != "\r\n" && line != ""; line, _ = br.ReadString('\n') {
	}
	fmt.Fprintf(c, "GET / HTTP/1.0\r\nHost: 10.99.0.1\r\n\r\n")
	all, _ := io.ReadAll(br)
	if !strings.Contains(string(all), "hello through the tunnel") {
		t.Fatalf("CONNECT body %q", all)
	}

	// CONNECT without the secret, then with it on the same connection: what
	// Android's own HTTP client does (it answers a 407 on the same socket).
	// Reported: the app's update over the tunnel failed with "unexpected end
	// of stream on null", the proxy having closed after its 407.
	{
		c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", tun.Port()))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		br := bufio.NewReader(c)
		fmt.Fprintf(c, "CONNECT 10.99.0.1:8080 HTTP/1.1\r\nHost: 10.99.0.1:8080\r\n\r\n")
		res, err := http.ReadResponse(br, nil)
		if err != nil || res.StatusCode != http.StatusProxyAuthRequired {
			t.Fatalf("first CONNECT: %v %v", res, err)
		}
		fmt.Fprintf(c, "CONNECT 10.99.0.1:8080 HTTP/1.1\r\nHost: 10.99.0.1:8080\r\nProxy-Authorization: Basic YnVycm93OnMzY3JldA==\r\n\r\n")
		res, err = http.ReadResponse(br, nil)
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("CONNECT again with the secret, same connection: %v %v", res, err)
		}
		fmt.Fprintf(c, "GET / HTTP/1.0\r\nHost: 10.99.0.1\r\n\r\n")
		all, _ := io.ReadAll(br)
		if !strings.Contains(string(all), "hello through the tunnel") {
			t.Fatalf("after the second CONNECT: %q", all)
		}
	}

	// A large body, whole: plain and through CONNECT, several at once (a
	// page's requests). Reported: over the tunnel, answers came cut short.
	get := func(path string) []byte {
		res, err := proxy(url.UserPassword("burrow", "s3cret")).Get("http://10.99.0.1:8080/" + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatalf("%s: %v after %d bytes", path, err, len(b))
		}
		return b
	}
	want := strings.TrimSpace(string(get("big.sha")))
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		go func(i int) {
			var b []byte
			if i%2 == 0 {
				res, err := proxy(url.UserPassword("burrow", "s3cret")).Get("http://10.99.0.1:8080/big.bin")
				if err != nil {
					errs <- err
					return
				}
				b, err = io.ReadAll(res.Body)
				res.Body.Close()
				if err != nil {
					errs <- fmt.Errorf("plain: %v after %d bytes", err, len(b))
					return
				}
			} else {
				c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", tun.Port()))
				if err != nil {
					errs <- err
					return
				}
				defer c.Close()
				fmt.Fprintf(c, "CONNECT 10.99.0.1:8080 HTTP/1.1\r\nHost: 10.99.0.1:8080\r\nProxy-Authorization: Basic YnVycm93OnMzY3JldA==\r\n\r\n")
				br := bufio.NewReader(c)
				if _, err := http.ReadResponse(br, nil); err != nil {
					errs <- err
					return
				}
				fmt.Fprintf(c, "GET /big.bin HTTP/1.1\r\nHost: 10.99.0.1\r\nConnection: close\r\n\r\n")
				res, err := http.ReadResponse(br, nil)
				if err != nil {
					errs <- err
					return
				}
				b, err = io.ReadAll(res.Body)
				if err != nil {
					errs <- fmt.Errorf("CONNECT: %v after %d bytes", err, len(b))
					return
				}
			}
			sum := sha256.Sum256(b)
			if got := hex.EncodeToString(sum[:]); got != want {
				errs <- fmt.Errorf("request %d: %d bytes, sha %s, want %s", i, len(b), got, want)
				return
			}
			errs <- nil
		}(i)
	}
	for i := 0; i < 6; i++ {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}

	// Outside the tunnel's networks: refused, never dialled from the phone.
	res, err = proxy(url.UserPassword("burrow", "s3cret")).Get("http://1.1.1.1/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("outside AllowedIPs: %d", res.StatusCode)
	}
}

// A plain-http request's authority with its port: IPv6 kept in brackets, the default only when none (AUDIT2 AND-16).
func TestWithPort(t *testing.T) {
	for in, want := range map[string]string{
		"nas.lan":        "nas.lan:80",
		"nas.lan:8080":   "nas.lan:8080",
		"10.0.0.5":       "10.0.0.5:80",
		"10.0.0.5:8096":  "10.0.0.5:8096",
		"[fd00::5]":      "[fd00::5]:80",
		"[fd00::5]:8443": "[fd00::5]:8443",
		"fd00::5":        "[fd00::5]:80",
	} {
		if got := withPort(in, "80"); got != want {
			t.Errorf("withPort(%q) = %q, want %q", in, got, want)
		}
	}
}

// Connections not signed in yet: only so many at once, and only so many header bytes each (AUDIT2 AND-14).
func TestUnauthenticatedBounds(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tun := &Tunnel{ln: ln, auth: "Basic c2VjcmV0", maxWaiting: 2}
	tun.wg.Add(1)
	go tun.serve()
	defer func() { _ = ln.Close(); tun.wg.Wait() }()
	closed := func(c net.Conn) bool {
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, err := c.Read(make([]byte, 1))
		return err == io.EOF
	}
	// Two held open without a word: a third comes, and the oldest goes, not the new one. A local
	// app holding the places open shut Burrow's own requests out (audit 2026-11-09).
	var held []net.Conn
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, c)
		time.Sleep(50 * time.Millisecond)
	}
	third, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if !closed(held[0]) {
		t.Error("the oldest connection not signed in was kept")
	}
	_ = third.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, err := third.Read(make([]byte, 1)); err == io.EOF {
		t.Error("the newest connection was closed instead of the oldest")
	}
	for _, c := range append(held, third) {
		_ = c.Close()
	}
	time.Sleep(100 * time.Millisecond)
	// Headers past the limit before the secret: closed, not read on.
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	go func() {
		_, _ = io.WriteString(c, "GET http://x/ HTTP/1.1\r\nHost: x\r\nX-Big: "+strings.Repeat("a", 80<<10)+"\r\n\r\n")
	}()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	got, _ := io.ReadAll(c)
	if strings.Contains(string(got), "407") {
		t.Errorf("an oversized header was read to the end and answered: %q", got)
	}
}

// fakeDNS stands in for the DNS of the network the phone is on (a hostile
// Wi-Fi): it answers every A question with addr and counts the questions.
func fakeDNS(t *testing.T, addr [4]byte) (string, *atomic.Int32) {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	var asked atomic.Int32
	go func() {
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
			// The question: name labels, then type and class.
			end := 12
			for end < n && q[end] != 0 {
				end += int(q[end]) + 1
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
			if qtype == 1 {
				binary.BigEndian.PutUint16(out[6:8], 1)
				out = append(out, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, addr[0], addr[1], addr[2], addr[3])
			} else {
				binary.BigEndian.PutUint16(out[6:8], 0)
			}
			_, _ = pc.WriteTo(out, from)
		}
	}()
	return pc.LocalAddr().String(), &asked
}

// A name goes only to the tunnel's own DNS. When that does not answer (or
// there is none), the lookup fails: the phone's own resolver, which the
// network it is on controls, is never asked, so it cannot pick where a
// request with the tab's cookies goes (A3-AND-01).
func TestNamesAreNeverAskedOutsideTheTunnel(t *testing.T) {
	local, asked := fakeDNS(t, [4]byte{10, 99, 0, 1})
	saved := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", local)
	}}
	t.Cleanup(func() { net.DefaultResolver = saved })
	// The stand-in works: asked straight, it answers with its own pick.
	if got, err := net.DefaultResolver.LookupNetIP(context.Background(), "ip4", "nas.lan"); err != nil || len(got) == 0 || got[0].String() != "10.99.0.1" {
		t.Fatalf("the stand-in DNS: %v %v", got, err)
	}
	asked.Store(0)

	// The tunnel's DNS (10.99.0.1) never answers: no peer behind this netstack.
	dev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.99.0.2")}, []netip.Addr{netip.MustParseAddr("10.99.0.1")}, 1420)
	if err != nil {
		t.Fatal(err)
	}
	// What the stack sends out goes nowhere (read and dropped, as a tunnel without its peer).
	go func() {
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		for {
			if _, err := dev.Read(bufs, sizes, 0); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = dev.Close() })
	// A full tunnel, as wg-easy hands out: every address is covered.
	full := []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}
	for _, dns := range []bool{true, false} {
		tun := &Tunnel{tnet: tnet, dns: dns, allowed: full}
		// As long as the proxy gives a request (handle): the tunnel's DNS gives up first.
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		a, err := tun.resolve(ctx, "nas.lan")
		cancel()
		if err == nil {
			t.Errorf("DNS line %v: nas.lan resolved to %s", dns, a)
		} else if !strings.Contains(err.Error(), "nas.lan") {
			t.Errorf("DNS line %v: the error does not name the host: %v", dns, err)
		}
		if n := asked.Load(); n != 0 {
			t.Errorf("DNS line %v: the phone's own DNS was asked %d times", dns, n)
		}
		// The refusal is kept for the app's error screens, and said to the one asking.
		ctx, cancel = context.WithTimeout(context.Background(), 20*time.Second)
		_, err = tun.dial(ctx, "nas.lan:8080")
		cancel()
		if err == nil || !strings.Contains(tun.LastRefusal(), "nas.lan") {
			t.Errorf("DNS line %v: dial %v, last refusal %q", dns, err, tun.LastRefusal())
		}
		client, server := net.Pipe()
		go func() { badGateway(server, err); _ = server.Close() }()
		res, rerr := http.ReadResponse(bufio.NewReader(client), nil)
		if rerr != nil || res.StatusCode != http.StatusBadGateway || !strings.Contains(res.Status, "nas.lan") {
			t.Errorf("the 502 says why: %v %v", res, rerr)
		} else {
			body, _ := io.ReadAll(res.Body)
			if !strings.Contains(string(body), "the phone's own DNS is not asked") {
				t.Errorf("the 502's page: %q", body)
			}
		}
		_ = client.Close()
		if n := asked.Load(); n != 0 {
			t.Errorf("DNS line %v: the phone's own DNS was asked %d times", dns, n)
		}
		// An address needs no lookup at all.
		if a, err := tun.resolve(context.Background(), "10.99.0.1"); err != nil || a.String() != "10.99.0.1" {
			t.Errorf("an address: %v %v", a, err)
		}
	}
}
