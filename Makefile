SHELL=/bin/bash

site/css/*:
	yarn build-css

dist: site/css/*
	yarn build

clean:
	rm site/css/*
	rm -rf dist
