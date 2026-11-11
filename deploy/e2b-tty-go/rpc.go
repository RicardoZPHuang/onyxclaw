package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type sandbox struct {
	ID           string `json:"sandboxID"`
	EnvdToken    string `json:"envdAccessToken"`
	TrafficToken string `json:"trafficAccessToken"`
}

type client struct {
	http                          *http.Client
	timeout                       time.Duration
	apiURL, gateway, apiKey, user string
	sandbox                       sandbox
}

func newClient(o options) *client {
	return &client{http: &http.Client{Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: o.requestTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: o.requestTimeout, ResponseHeaderTimeout: o.requestTimeout,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: o.insecure}, // Explicit opt-in for private/self-signed endpoints.
	}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		timeout: o.requestTimeout, apiURL: o.apiURL, gateway: o.gateway, apiKey: o.apiKey, user: o.user}
}

func validURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("expected an HTTP(S) base URL without credentials, query or fragment")
	}
	return strings.TrimRight(raw, "/"), nil
}

func (c *client) redact(s string) string {
	for _, secret := range []string{c.apiKey, c.sandbox.EnvdToken, c.sandbox.TrafficToken} {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "[redacted]")
		}
	}
	return s
}

func (c *client) request(ctx context.Context, base, path string, body []byte, stream, control bool, method string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if control {
		req.Header.Set("X-API-Key", c.apiKey)
	} else {
		req.Header.Set("Connect-Protocol-Version", "1")
		req.Header.Set("E2b-Sandbox-Id", c.sandbox.ID)
		req.Header.Set("E2b-Sandbox-Port", "49983")
		req.Header.Set("E2B-Traffic-Access-Token", c.sandbox.TrafficToken)
		if c.sandbox.EnvdToken != "" {
			req.Header.Set("X-Access-Token", c.sandbox.EnvdToken)
		}
		if stream {
			req.Header.Set("Content-Type", "application/connect+json")
			req.Header.Set("Connect-Content-Encoding", "identity")
			req.Header.Set("Keepalive-Ping-Interval", "50")
			if path == "/process.Process/Start" {
				req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.user+":")))
			}
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %s", method, path, c.redact(err.Error()))
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		defer res.Body.Close()
		data, readErr := io.ReadAll(io.LimitReader(res.Body, 16384))
		if readErr != nil {
			return nil, fmt.Errorf("%s %s: HTTP %d (reading error: %v)", method, path, res.StatusCode, readErr)
		}
		return nil, fmt.Errorf("%s %s: HTTP %d: %s", method, path, res.StatusCode, c.redact(string(data)))
	}
	return res, nil
}

func (c *client) control(ctx context.Context, method, path string, payload any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	res, err := c.request(ctx, c.apiURL, path, body, false, true, method)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if result != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(result)
	}
	return nil
}

func (c *client) open(ctx context.Context, o options) error {
	path := "/sandboxes"
	body := map[string]any{"templateID": o.template, "timeout": o.sandboxTimeout, "secure": true, "autoPause": false, "envVars": map[string]string(o.envs)}
	if o.sandboxID != "" {
		path += "/" + url.PathEscape(o.sandboxID) + "/connect"
		body = map[string]any{"timeout": o.sandboxTimeout}
	}
	if err := c.control(ctx, http.MethodPost, path, body, &c.sandbox); err != nil {
		return err
	}
	if c.sandbox.ID == "" {
		return fmt.Errorf("control API response has no sandboxID")
	}
	if c.sandbox.TrafficToken == "" {
		return fmt.Errorf("sandbox %s: control API response has no trafficAccessToken", c.sandbox.ID)
	}
	return nil
}

func (c *client) unary(ctx context.Context, method string, payload any) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	res, err := c.request(ctx, c.gateway, "/process.Process/"+method, body, false, false, http.MethodPost)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	return err
}

func envelope(flags byte, data []byte) []byte {
	frame := make([]byte, 5+len(data))
	frame[0] = flags
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(data)))
	copy(frame[5:], data)
	return frame
}

type event struct {
	Start *struct {
		PID int `json:"pid"`
	} `json:"start"`
	Data *struct{ Stdout, Stderr, Pty []byte } `json:"data"`
	End  *struct {
		ExitCode int    `json:"exitCode"`
		Exited   bool   `json:"exited"`
		Error    string `json:"error"`
		Status   string `json:"status"`
	} `json:"end"`
}

type eventStream struct{ io.ReadCloser }

func (s *eventStream) next() (event, error) {
	var head [5]byte
	if _, err := io.ReadFull(s, head[:]); err != nil {
		if err == io.EOF {
			return event{}, io.ErrUnexpectedEOF
		}
		return event{}, err
	}
	n := binary.BigEndian.Uint32(head[1:])
	if n > 16<<20 {
		return event{}, fmt.Errorf("RPC frame too large: %d", n)
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(s, data); err != nil {
		return event{}, err
	}
	if head[0]&1 != 0 {
		return event{}, fmt.Errorf("unsupported compressed RPC frame")
	}
	if head[0]&^byte(2) != 0 {
		return event{}, fmt.Errorf("invalid RPC frame flags: %d", head[0])
	}
	if head[0]&2 != 0 {
		var end struct {
			Error *struct{ Code, Message string } `json:"error"`
		}
		if err := json.Unmarshal(data, &end); err != nil {
			return event{}, err
		}
		if end.Error != nil {
			return event{}, fmt.Errorf("RPC %s: %s", end.Error.Code, end.Error.Message)
		}
		return event{}, io.EOF
	}
	var res struct {
		Event event `json:"event"`
	}
	err := json.Unmarshal(data, &res)
	return res.Event, err
}

func (c *client) start(ctx context.Context, o options, rows, cols int) (*eventStream, int, error) {
	method := "Start"
	proc := map[string]any{"cmd": "/bin/bash", "args": []string{"-i", "-l"}, "cwd": o.cwd,
		"envs": map[string]string{"TERM": envDefault("TERM", "xterm-256color"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}}
	body := map[string]any{"process": proc, "pty": map[string]any{"size": map[string]int{"rows": rows, "cols": cols}}}
	if o.commandMode || o.exec != "" {
		command := "exec " + o.shell
		if o.exec != "" {
			command = o.exec
		}
		proc["args"] = []string{"-c", command}
		body = map[string]any{"process": proc, "stdin": true}
	}
	if o.pid > 0 {
		method = "Connect"
		body = map[string]any{"process": map[string]int{"pid": o.pid}}
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	res, err := c.request(ctx, c.gateway, "/process.Process/"+method, envelope(0, data), true, false, http.MethodPost)
	if err != nil {
		return nil, 0, err
	}
	s := &eventStream{res.Body}
	// Streaming has no lifetime deadline, but receiving the first event does.
	firstEventTimer := time.AfterFunc(c.timeout, func() { res.Body.Close() })
	defer firstEventTimer.Stop()
	ev, err := s.next()
	if err != nil {
		s.Close()
		return nil, 0, err
	}
	if ev.Start == nil || ev.Start.PID <= 0 {
		s.Close()
		return nil, 0, fmt.Errorf("expected process start event")
	}
	return s, ev.Start.PID, nil
}

func (c *client) input(ctx context.Context, pid int, data []byte, command bool) error {
	name := "pty"
	if command {
		name = "stdin"
	}
	return c.unary(ctx, "SendInput", map[string]any{"process": map[string]int{"pid": pid}, "input": map[string][]byte{name: data}})
}
func (c *client) resize(ctx context.Context, pid, rows, cols int) error {
	return c.unary(ctx, "Update", map[string]any{"process": map[string]int{"pid": pid}, "pty": map[string]any{"size": map[string]int{"rows": rows, "cols": cols}}})
}
