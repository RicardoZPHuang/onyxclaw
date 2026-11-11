//go:build !windows

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/term"
)

func beginTerminal(fd int) (func(), error) {
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, err
	}
	return func() { term.Restore(fd, state) }, nil
}

func terminalSize() (int, int, error) { return term.GetSize(int(os.Stdout.Fd())) }

func interruptContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
}

func resizeNotifications(ctx context.Context) (<-chan struct{}, func()) {
	ctx, cancel := context.WithCancel(ctx)
	sig := make(chan os.Signal, 1)
	notifications := make(chan struct{}, 1)
	signal.Notify(sig, syscall.SIGWINCH)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sig:
				select {
				case notifications <- struct{}{}:
				default:
				}
			}
		}
	}()
	return notifications, func() { signal.Stop(sig); cancel() }
}
