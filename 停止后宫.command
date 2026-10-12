#!/bin/sh
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$project_dir/scripts/bootstrap.sh" --stop
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ]; then printf '\nCould not stop Palace. Press Enter to close.'; read -r answer; fi
exit "$result"
