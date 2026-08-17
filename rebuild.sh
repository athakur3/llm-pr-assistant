#!/bin/sh
set -e

rm -rf dist
npm run typecheck
npm run package
