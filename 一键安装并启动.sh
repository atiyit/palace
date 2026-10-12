#!/bin/sh
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$project_dir/scripts/bootstrap.sh" "$@"
