#!/bin/bash
set -e

PI_USER="j85473"
PI_HOST="192.168.1.208"
DEST_DIR="/opt/career-dashboard"

echo "Deploying Career Dashboard to Raspberry Pi ($PI_HOST)..."

# Ensure destination exists
ssh -t $PI_USER@$PI_HOST "sudo mkdir -p $DEST_DIR && sudo chown $PI_USER:$PI_USER $DEST_DIR"

# Rsync files (excluding unnecessary ones)
echo "Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude 'dev.db' \
  --exclude 'prisma/generated' \
  --exclude 'prisma/schema.sqlite.prisma' \
  ./ $PI_USER@$PI_HOST:$DEST_DIR/

# Run build on Pi
echo "Building on Pi..."
ssh -t $PI_USER@$PI_HOST "cd $DEST_DIR && npm install && npx prisma generate && npm run build"

# Restart service
echo "Restarting service..."
ssh -t $PI_USER@$PI_HOST "sudo systemctl restart career-dashboard"

echo "Deployment complete!"
