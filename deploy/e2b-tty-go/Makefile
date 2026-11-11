GO ?= go
BUILD_FLAGS = -trimpath -ldflags="-s -w"

.PHONY: build test
build:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build $(BUILD_FLAGS) -o bin/e2b-tty-linux-amd64 .
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build $(BUILD_FLAGS) -o bin/e2b-tty-linux-arm64 .
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GO) build $(BUILD_FLAGS) -o bin/e2b-tty-darwin-arm64 .
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build $(BUILD_FLAGS) -o bin/e2b-tty-windows-amd64.exe .
	cd bin && shasum -a 256 e2b-tty-* > SHA256SUMS

test:
	$(GO) test -race ./...
	$(GO) vet ./...
