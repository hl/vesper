.PHONY: build check format lint test typecheck

VERSION := $(shell bun -e "const p = await Bun.file('package.json').json(); console.log(p.version)")

build:
	bun build src/index.ts --compile --define "VESPER_VERSION='$(VERSION)'" --outfile vesper

check: typecheck lint test

format:
	bunx biome format --write .

lint:
	bunx biome lint .

test:
	bun test

typecheck:
	bunx tsc --noEmit
