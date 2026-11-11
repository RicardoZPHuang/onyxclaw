package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/term"
)

// Console mode restoration does not reset VT private mouse tracking modes.
const resetMouseTracking = "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l"

func beginTerminal(fd int) (func(), error) {
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, fmt.Errorf("enable Windows terminal input: %w (use Windows Terminal or PowerShell)", err)
	}
	var restoreOutput []func()
	vtReady := false
	restore := func() {
		if vtReady {
			io.WriteString(os.Stdout, resetMouseTracking)
		}
		for i := len(restoreOutput) - 1; i >= 0; i-- {
			restoreOutput[i]()
		}
		term.Restore(fd, state)
	}
	// Prevent console mouse events from becoming shell input; keep keyboard
	// VT input. Quick Edit can also pause the console while text is selected.
	input := windows.Handle(fd)
	var inputMode uint32
	if err = windows.GetConsoleMode(input, &inputMode); err == nil {
		err = windows.SetConsoleMode(input, (inputMode&^(windows.ENABLE_QUICK_EDIT_MODE|windows.ENABLE_MOUSE_INPUT))|windows.ENABLE_EXTENDED_FLAGS)
	}
	if err != nil {
		restore()
		return nil, fmt.Errorf("configure Windows console input: %w", err)
	}
	for _, file := range []*os.File{os.Stdout, os.Stderr} {
		handle := windows.Handle(file.Fd())
		var mode uint32
		if err := windows.GetConsoleMode(handle, &mode); err != nil {
			// stderr can legitimately be redirected to a file.
			if file == os.Stderr {
				continue
			}
			restore()
			return nil, fmt.Errorf("read Windows console output mode: %w", err)
		}
		if err := windows.SetConsoleMode(handle, mode|windows.ENABLE_PROCESSED_OUTPUT|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING); err != nil {
			restore()
			return nil, fmt.Errorf("enable Windows VT output: %w (use Windows Terminal)", err)
		}
		restoreOutput = append(restoreOutput, func() { windows.SetConsoleMode(handle, mode) })
		if file == os.Stdout {
			vtReady = true
		}
	}
	if _, err := io.WriteString(os.Stdout, resetMouseTracking); err != nil {
		restore()
		return nil, fmt.Errorf("reset Windows mouse tracking: %w", err)
	}
	// Go's os.File console I/O converts UTF-8 to/from Unicode console APIs.
	return restore, nil
}

func terminalSize() (int, int, error) { return term.GetSize(int(os.Stdout.Fd())) }

func interruptContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
}

func resizeNotifications(ctx context.Context) (<-chan struct{}, func()) {
	ctx, cancel := context.WithCancel(ctx)
	notifications := make(chan struct{}, 1)
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				select {
				case notifications <- struct{}{}:
				default:
				}
			}
		}
	}()
	return notifications, cancel
}
