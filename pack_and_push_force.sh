#!/bin/bash
. ~/.zshshared
npm run package && gitforce --amend --no-edit
git rev-parse HEAD | xargs | pbcopy
git rev-parse HEAD
