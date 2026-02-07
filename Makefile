.PHONY: build run clean deploy demo-blocking install test test-alpine

# Build the Docker image locally
build:
	docker build -t agentsh-blaxel .

# Run the container locally for testing
run: build
	docker run -it --rm \
		-p 18080:18080 \
		-p 8080:8080 \
		agentsh-blaxel

# Run with shell access for debugging
shell: build
	docker run -it --rm \
		-p 18080:18080 \
		-p 8080:8080 \
		agentsh-blaxel /bin/bash.real

# Install npm dependencies
install:
	npm install

# Deploy to Blaxel
deploy:
	bl deploy

# Run command blocking demo
demo-blocking: install
	npx tsx demo-blocking.ts

# Run tests
test: install
	npx tsx test-debian.ts

test-alpine: install
	npx tsx test-alpine.ts

# Clean up
clean:
	docker rmi agentsh-blaxel 2>/dev/null || true
	rm -rf node_modules

# Show help
help:
	@echo "agentsh + Blaxel Demo"
	@echo ""
	@echo "Usage:"
	@echo "  make build          Build Docker image locally"
	@echo "  make run            Run container locally"
	@echo "  make shell          Run container with shell access"
	@echo "  make install        Install npm dependencies"
	@echo "  make deploy         Deploy to Blaxel"
	@echo "  make demo-blocking  Run command blocking demo"
	@echo "  make test           Run Debian test suite"
	@echo "  make test-alpine    Run Alpine test suite"
	@echo "  make clean          Remove image and node_modules"
