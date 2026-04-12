.PHONY: build check format lint test typecheck

build:
	bun build src/index.ts --compile --outfile vesper

check: typecheck lint test

format:
	bunx biome format --write .

lint:
	bunx biome lint .

test:
	bun test

typecheck:
	bunx tsc --noEmit
