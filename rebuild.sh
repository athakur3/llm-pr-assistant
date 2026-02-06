#!/bin/sh
set -e

rm -rf out     
npm run compile
npm run package