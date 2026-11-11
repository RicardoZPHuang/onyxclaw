package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"
)

type envValues map[string]string

func (e *envValues) String() string { return "NAME=VALUE" }
func (e *envValues) Set(s string) error {
	k, v, ok := strings.Cut(s, "=")
	if !ok || k == "" || strings.ContainsAny(k, "\x00") || strings.ContainsAny(v, "\x00") {
		return fmt.Errorf("--env must be NAME=VALUE")
	}
	if *e == nil {
		*e = envValues{}
	}
	(*e)[k] = v
	return nil
}

type options struct {
	apiURL, gateway, apiKey, template, sandboxID, user, cwd, shell, exec string
	pid, sandboxTimeout, retries                                         int
	retryInterval, requestTimeout                                        time.Duration
	commandMode, killOnExit, createOnly                                  bool
	insecure                                                             bool
	envs                                                                 envValues
}

func envDefault(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func parseOptions() (options, error) {
	var o options
	insecureDefault := false
	if value := os.Getenv("E2B_INSECURE"); value != "" {
		var err error
		insecureDefault, err = strconv.ParseBool(value)
		if err != nil {
			return o, fmt.Errorf("E2B_INSECURE: expected a boolean: %w", err)
		}
	}
	flag.StringVar(&o.apiURL, "api-url", envDefault("E2B_API_URL", "https://agentsandbox.cn-north-4.myhuaweicloud.com"), "control API base URL")
	flag.StringVar(&o.gateway, "sandbox-url", os.Getenv("E2B_SANDBOX_URL"), "sandbox gateway base URL (required)")
	flag.BoolVar(&o.insecure, "insecure", insecureDefault, "skip TLS certificate verification for API and sandbox gateway (E2B_INSECURE)")
	flag.StringVar(&o.apiKey, "api-key", "", "API key (prefer E2B_API_KEY environment variable)")
	flag.StringVar(&o.template, "template", os.Getenv("E2B_TEMPLATE_ID"), "template ID when creating a sandbox")
	flag.StringVar(&o.sandboxID, "sandbox-id", os.Getenv("E2B_SANDBOX_ID"), "connect to existing sandbox")
	flag.IntVar(&o.pid, "pty-pid", 0, "reattach to an existing process")
	flag.StringVar(&o.user, "user", "root", "process user")
	flag.StringVar(&o.cwd, "cwd", "/root", "working directory")
	flag.StringVar(&o.shell, "shell", "/bin/bash -li", "shell used with --command-mode")
	flag.IntVar(&o.sandboxTimeout, "sandbox-timeout", 3600, "sandbox lifetime in seconds; connect also renews lifetime")
	flag.IntVar(&o.retries, "session-retries", 5, "retries after session not found")
	var retrySeconds float64
	flag.Float64Var(&retrySeconds, "session-retry-interval", 2, "seconds between session retries")
	flag.DurationVar(&o.requestTimeout, "request-timeout", 30*time.Second, "API/unary RPC/header timeout, e.g. 30s")
	flag.BoolVar(&o.commandMode, "command-mode", false, "use stdin/stdout command stream instead of PTY")
	flag.BoolVar(&o.killOnExit, "kill-on-exit", false, "delete sandbox on exit, including an existing sandbox")
	flag.BoolVar(&o.createOnly, "create-only", false, "create sandbox and output sandboxID JSON, without terminal")
	flag.StringVar(&o.exec, "exec", "", "execute a command without a local TTY; return remote exit code")
	flag.Var(&o.envs, "env", "creation environment variable NAME=VALUE (repeatable)")
	flag.Parse()
	if flag.NArg() != 0 {
		return o, fmt.Errorf("unexpected positional arguments; use --sandbox-id and --sandbox-url")
	}
	o.retryInterval = time.Duration(retrySeconds * float64(time.Second))
	if o.apiKey == "" {
		o.apiKey = envDefault("E2B_API_KEY", os.Getenv("HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY"))
	}
	if o.apiKey == "" {
		return o, fmt.Errorf("set E2B_API_KEY")
	}
	var err error
	if o.apiURL, err = validURL(o.apiURL); err != nil {
		return o, fmt.Errorf("--api-url: %w", err)
	}
	if o.gateway, err = validURL(o.gateway); err != nil {
		return o, fmt.Errorf("--sandbox-url: %w", err)
	}
	if o.sandboxID == "" && o.template == "" {
		return o, fmt.Errorf("provide --sandbox-id or --template")
	}
	if o.pid < 0 || o.sandboxTimeout <= 0 || o.retries < 0 || retrySeconds < 0 || o.requestTimeout <= 0 {
		return o, fmt.Errorf("invalid PID, timeout or retry value")
	}
	if o.pid > 0 && o.sandboxID == "" {
		return o, fmt.Errorf("--pty-pid requires --sandbox-id")
	}
	if o.createOnly && (o.sandboxID != "" || o.pid > 0 || o.exec != "" || o.killOnExit || o.commandMode) {
		return o, fmt.Errorf("--create-only requires a new sandbox and cannot be combined with terminal/kill options")
	}
	if o.exec != "" && (o.pid > 0 || o.commandMode) {
		return o, fmt.Errorf("--exec cannot be combined with --pty-pid or --command-mode")
	}
	if len(o.envs) > 0 && o.sandboxID != "" {
		return o, fmt.Errorf("--env applies only when creating a sandbox")
	}
	return o, nil
}

type outcome struct {
	code int
	err  error
}

func outputStream(s *eventStream) outcome {
	for {
		ev, err := s.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return outcome{err: fmt.Errorf("RPC stream ended without a process end event; process may still be running")}
			}
			return outcome{err: err}
		}
		if ev.Data != nil {
			for _, part := range []struct {
				w io.Writer
				b []byte
			}{{os.Stdout, ev.Data.Pty}, {os.Stdout, ev.Data.Stdout}, {os.Stderr, ev.Data.Stderr}} {
				if len(part.b) > 0 {
					if _, err := part.w.Write(part.b); err != nil {
						return outcome{err: err}
					}
				}
			}
		}
		if ev.End != nil {
			if !ev.End.Exited {
				return outcome{err: fmt.Errorf("remote process did not exit normally: %s %s", ev.End.Status, ev.End.Error)}
			}
			// envd includes an error string for ordinary nonzero exit codes.
			return outcome{code: ev.End.ExitCode}
		}
	}
}
func inputPrefix(b []byte) ([]byte, bool) {
	if i := bytes.IndexByte(b, 0x1d); i >= 0 {
		return b[:i], true
	}
	return b, false
}

func session(ctx context.Context, c *client, o options) (int, error) {
	interactive := o.exec == ""
	fd := int(os.Stdin.Fd())
	if interactive && (!term.IsTerminal(fd) || !term.IsTerminal(int(os.Stdout.Fd()))) {
		return 1, fmt.Errorf("interactive mode requires a TTY; use --exec for commands")
	}
	rows, cols := 24, 80
	if interactive {
		if w, h, err := terminalSize(); err == nil {
			cols, rows = w, h
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var s *eventStream
	var pid int
	var err error
	for attempt := 0; ; attempt++ {
		s, pid, err = c.start(ctx, o, rows, cols)
		if err == nil {
			break
		}
		if attempt >= o.retries || !strings.Contains(strings.ToLower(err.Error()), "session not found") {
			return 1, err
		}
		fmt.Fprintf(os.Stderr, "Session not found; retry %d/%d in %s...\n", attempt+1, o.retries, o.retryInterval)
		timer := time.NewTimer(o.retryInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return 1, ctx.Err()
		case <-timer.C:
		}
	}
	defer s.Close()
	var restoreTerminal func()
	if interactive {
		fmt.Fprintf(os.Stderr, "Sandbox: %s  PID: %d\nCtrl-] detaches. Reattach with --sandbox-id %s --pty-pid %d\n", c.sandbox.ID, pid, c.sandbox.ID, pid)
		restore, err := beginTerminal(fd)
		if err != nil {
			return 1, err
		}
		restoreTerminal = restore
	}
	done := make(chan outcome, 1)
	outputStopped := make(chan struct{})
	go func() { defer close(outputStopped); done <- outputStream(s) }()
	defer func() {
		// Stop remote output before restoring modes and resetting mouse tracking.
		cancel()
		s.Close()
		<-outputStopped
		if restoreTerminal != nil {
			restoreTerminal()
		}
	}()
	inputDone := make(chan outcome, 1)
	if interactive {
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := os.Stdin.Read(buf)
				if n > 0 {
					data, detach := inputPrefix(buf[:n])
					if len(data) > 0 {
						if e := c.input(ctx, pid, data, o.commandMode); e != nil {
							inputDone <- outcome{err: e}
							return
						}
					}
					if detach {
						inputDone <- outcome{}
						return
					}
				}
				if err != nil {
					if err == io.EOF {
						err = nil
					}
					inputDone <- outcome{err: err}
					return
				}
			}
		}()
	}
	var winch <-chan struct{}
	if interactive && !o.commandMode {
		var stopResize func()
		winch, stopResize = resizeNotifications(ctx)
		defer stopResize()
		// A reattached PTY may have a different previous size.
		if o.pid > 0 {
			if err := c.resize(ctx, pid, rows, cols); err != nil {
				return 1, err
			}
		}
	}
	for {
		select {
		case result := <-done:
			return result.code, result.err
		case result := <-inputDone:
			return result.code, result.err
		case <-ctx.Done():
			return 1, ctx.Err()
		case <-winch:
			if w, h, err := terminalSize(); err == nil && (w != cols || h != rows) {
				if err := c.resize(ctx, pid, h, w); err != nil {
					return 1, err
				}
				cols, rows = w, h
			}
		}
	}
}

func run() (int, error) {
	o, err := parseOptions()
	if err != nil {
		return 1, err
	}
	if !o.createOnly && o.exec == "" && (!term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd()))) {
		return 1, fmt.Errorf("interactive mode requires a TTY; use --exec for commands")
	}
	ctx, stop := interruptContext(context.Background())
	defer stop()
	c := newClient(o)
	defer c.http.CloseIdleConnections()
	if err := c.open(ctx, o); err != nil {
		return 1, err
	}
	fmt.Fprintf(os.Stderr, "Sandbox: %s\n", c.sandbox.ID)
	if o.killOnExit {
		defer func() {
			if err := c.control(context.Background(), http.MethodDelete, "/sandboxes/"+url.PathEscape(c.sandbox.ID), nil, nil); err != nil {
				fmt.Fprintln(os.Stderr, "sandbox cleanup:", err)
			}
		}()
	}
	if o.createOnly {
		return 0, json.NewEncoder(os.Stdout).Encode(map[string]string{"sandboxID": c.sandbox.ID})
	}
	code, err := session(ctx, c, o)
	if err != nil {
		return 1, fmt.Errorf("%s", c.redact(err.Error()))
	}
	return code, nil
}
func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2b-tty:", err)
	}
	if code < 0 || code > 255 {
		code = 1
	}
	os.Exit(code)
}
