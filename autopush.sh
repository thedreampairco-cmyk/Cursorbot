#!/bin/bash
while true; do
  # Check if there are any changes
  if [[ -n $(git status -s) ]]; then
    echo "🚀 Changes detected! Force pushing to GitHub..."
    git add .
    git commit -m "Auto-update: $(date +'%Y-%m-%d %H:%M:%S')"
    git push --force
    echo "✅ Done. Waiting for next change..."
  fi
  sleep 5 # Check every 5 seconds
done
