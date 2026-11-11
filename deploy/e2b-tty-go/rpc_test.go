package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestInsecureOptions(t *testing.T) {
	for _, tc := range []struct {
		name, env string
		args      []string
		want      bool
		wantError bool
	}{
		{name: "default"},
		{name: "flag", args: []string{"--insecure"}, want: true},
		{name: "environment", env: "true", want: true},
		{name: "environment false", env: "false"},
		{name: "flag overrides environment", env: "true", args: []string{"--insecure=false"}},
		{name: "invalid environment", env: "invalid", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("E2B_INSECURE", tc.env)
			t.Setenv("E2B_API_KEY", "test-key")
			t.Setenv("E2B_API_URL", "https://api.example.com")
			t.Setenv("E2B_SANDBOX_URL", "https://gateway.example.com")
			savedFlags, savedArgs := flag.CommandLine, os.Args
			t.Cleanup(func() { flag.CommandLine, os.Args = savedFlags, savedArgs })
			flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
			os.Args = append([]string{"test", "--sandbox-id", "sandbox"}, tc.args...)
			o, err := parseOptions()
			if (err != nil) != tc.wantError || o.insecure != tc.want {
				t.Fatalf("insecure = %v, err = %v; want %v, error %v", o.insecure, err, tc.want, tc.wantError)
			}
		})
	}
}

func TestTLSCertificateVerification(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sandboxes":
			io.WriteString(w, `{"sandboxID":"sandbox","trafficAccessToken":"traffic"}`)
		case "/process.Process/Start":
			w.Write(envelope(0, []byte(`{"event":{"start":{"pid":123}}}`)))
		default:
			io.WriteString(w, `{}`)
		}
	}))
	defer server.Close()
	for _, insecure := range []bool{false, true} {
		name := "verify by default"
		if insecure {
			name = "explicit insecure"
		}
		t.Run(name, func(t *testing.T) {
			o := options{apiURL: server.URL, gateway: server.URL, apiKey: "key", requestTimeout: time.Second, insecure: insecure}
			c := newClient(o)
			defer c.http.CloseIdleConnections()
			ctx := context.Background()
			check := func(path string, err error) {
				t.Helper()
				if insecure && err != nil {
					t.Fatalf("%s: insecure request failed: %v", path, err)
				}
				if !insecure && (err == nil || !strings.Contains(err.Error(), "certificate")) {
					t.Fatalf("%s: expected certificate rejection, got %v", path, err)
				}
			}
			check("API", c.open(ctx, o))
			check("gateway unary", c.input(ctx, 123, []byte("hello"), false))
			s, _, err := c.start(ctx, o, 24, 80)
			if s != nil {
				defer s.Close()
			}
			check("gateway stream", err)
		})
	}
}

func TestCreateRoutingAndProcessProtocol(t *testing.T) {
	var seenInput, seenResize bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sandboxes" {
			if r.Header.Get("X-API-Key") != "test-api" {
				t.Error("missing API key")
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["secure"] != true || body["templateID"] != "template" || body["envVars"].(map[string]any)["CUSTOM"] != "value" {
				t.Errorf("invalid create: %v", body)
			}
			io.WriteString(w, `{"sandboxID":"sandbox","trafficAccessToken":"traffic","envdAccessToken":"envd"}`)
			return
		}
		if r.Header.Get("E2b-Sandbox-Id") != "sandbox" || r.Header.Get("E2b-Sandbox-Port") != "49983" || r.Header.Get("E2B-Traffic-Access-Token") != "traffic" || r.Header.Get("X-Access-Token") != "envd" {
			t.Errorf("invalid routing headers: %v", r.Header)
		}
		if r.Header.Get("Connect-Protocol-Version") != "1" {
			t.Error("missing Connect version")
		}
		var body map[string]any
		switch r.URL.Path {
		case "/process.Process/Start":
			if r.Header.Get("Content-Type") != "application/connect+json" || r.Header.Get("Authorization") != "Basic cm9vdDo=" {
				t.Error("bad stream headers")
			}
			var h [5]byte
			io.ReadFull(r.Body, h[:])
			data := make([]byte, binary.BigEndian.Uint32(h[1:]))
			io.ReadFull(r.Body, data)
			json.Unmarshal(data, &body)
			if body["process"].(map[string]any)["cwd"] != "/root" {
				t.Error("incorrect cwd")
			}
			w.Header().Set("Content-Type", "application/connect+json")
			for _, data := range []string{`{"event":{"start":{"pid":123}}}`, `{"event":{"data":{"stdout":"aGVsbG8="}}}`, `{"event":{"end":{"exited":true,"exitCode":7}}}`, `{}`} {
				flag := byte(0)
				if data == `{}` {
					flag = 2
				}
				w.Write(envelope(flag, []byte(data)))
			}
		case "/process.Process/SendInput":
			json.NewDecoder(r.Body).Decode(&body)
			seenInput = body["input"].(map[string]any)["pty"] == "aGVsbG8=" && body["process"].(map[string]any)["pid"] == float64(123)
			io.WriteString(w, `{}`)
		case "/process.Process/Update":
			json.NewDecoder(r.Body).Decode(&body)
			size := body["pty"].(map[string]any)["size"].(map[string]any)
			seenResize = size["rows"] == float64(40) && size["cols"] == float64(100)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	o := options{apiURL: server.URL, gateway: server.URL, apiKey: "test-api", user: "root", template: "template", cwd: "/root", sandboxTimeout: 3600, requestTimeout: time.Second, envs: envValues{"CUSTOM": "value"}}
	c := newClient(o)
	ctx := context.Background()
	if err := c.open(ctx, o); err != nil {
		t.Fatal(err)
	}
	s, pid, err := c.start(ctx, o, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if pid != 123 {
		t.Fatal(pid)
	}
	data, err := s.next()
	if err != nil || string(data.Data.Stdout) != "hello" {
		t.Fatalf("data: %v %v", data, err)
	}
	end, err := s.next()
	if err != nil || end.End.ExitCode != 7 {
		t.Fatalf("end: %v %v", end, err)
	}
	if _, err = s.next(); err != io.EOF {
		t.Fatal(err)
	}
	if err = c.input(ctx, pid, []byte("hello"), false); err != nil {
		t.Fatal(err)
	}
	if err = c.resize(ctx, pid, 40, 100); err != nil {
		t.Fatal(err)
	}
	if !seenInput || !seenResize {
		t.Fatal("input or resize payload incorrect")
	}
}

func TestNonstandard401AndCredentialRedaction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		io.WriteString(w, `{"error_code":"Sandbox.401001","detail":"not in subscribe whitelist","echo":"secret"}`)
	}))
	defer server.Close()
	c := newClient(options{apiURL: server.URL, apiKey: "secret", requestTimeout: time.Second})
	err := c.open(context.Background(), options{})
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || !strings.Contains(err.Error(), "not in subscribe whitelist") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("incorrect diagnostic: %v", err)
	}
}

func TestStreamErrorsAndPartialFrames(t *testing.T) {
	for _, tc := range []struct {
		data []byte
		want string
	}{
		{envelope(2, []byte(`{"error":{"code":"not_found","message":"session not found"}}`)), "session not found"},
		{[]byte{0, 0, 0}, "unexpected EOF"},
		{envelope(0, []byte(`{`)), "unexpected end"},
		{envelope(1, []byte(`{}`)), "compressed"},
		{[]byte{0, 255, 255, 255, 255}, "too large"},
	} {
		s := eventStream{io.NopCloser(bytes.NewReader(tc.data))}
		_, err := s.next()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("wanted %s, got %v", tc.want, err)
		}
	}
}

func TestDetachPreservesInputPrefix(t *testing.T) {
	prefix, detach := inputPrefix([]byte("abc\x1dignored"))
	if !detach || string(prefix) != "abc" {
		t.Fatal("incorrect detach handling")
	}
	prefix, detach = inputPrefix([]byte("abc"))
	if detach || string(prefix) != "abc" {
		t.Fatal("incorrect regular input")
	}
}

func TestEnvdNonzeroExitWithErrorString(t *testing.T) {
	s := &eventStream{io.NopCloser(bytes.NewReader(envelope(0, []byte(`{"event":{"end":{"exitCode":7,"exited":true,"error":"exit status 7"}}}`))))}
	result := outputStream(s)
	if result.code != 7 || result.err != nil {
		t.Fatalf("nonzero exit: %+v", result)
	}
}

func TestSessionClosesStreamingRequestOnProcessExit(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/connect+json")
		w.Write(envelope(0, []byte(`{"event":{"start":{"pid":123}}}`)))
		w.Write(envelope(0, []byte(`{"event":{"end":{"exitCode":7,"exited":true,"error":"exit status 7"}}}`)))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer server.Close()
	o := options{gateway: server.URL, requestTimeout: time.Second, exec: "exit 7", cwd: "/root"}
	c := newClient(o)
	c.sandbox = sandbox{ID: "sandbox", TrafficToken: "traffic"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	code, err := session(ctx, c, o)
	if code != 7 || err != nil {
		t.Fatalf("session result: %d %v", code, err)
	}
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("streaming request was not closed on process exit")
	}
}
