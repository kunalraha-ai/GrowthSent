#!/bin/bash
set -e

# Update package lists
apt-get update

# Install tools for running and monitoring rclone
apt-get install -y curl unzip tmux

# Install latest rclone
curl -fsSL https://rclone.org/install.sh | bash

# Prepare log directory
mkdir -p /var/log/rclone
