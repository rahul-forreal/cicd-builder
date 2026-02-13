#!/bin/bash
set -e

REPO_NAME=$1
COMMIT_SHA=$2
WORKSPACE=$3

IMAGE_REMOTE="$DOCKER_USERNAME/$REPO_NAME:$COMMIT_SHA"

echo "🔐 Logging into Docker Hub"
echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

echo "🐳 Building Docker image"
docker build -t $IMAGE_REMOTE -t $DOCKER_USERNAME/$REPO_NAME:latest $WORKSPACE


echo "📤 Pushing image to Docker Hub"
# docker push $IMAGE_REMOTE
docker push $DOCKER_USERNAME/$REPO_NAME:latest


echo "✅ Image pushed: $IMAGE_REMOTE"
