.PHONY: build run clean deploy demo-blocking demo-network demo-all install

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

# Run network policy demo
demo-network: install
	npx tsx demo-network.ts

# Run all demos
demo-all: demo-blocking demo-network

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
	@echo "  make demo-network   Run network policy demo"
	@echo "  make demo-all       Run all demos"
	@echo "  make clean          Remove image and node_modules"
