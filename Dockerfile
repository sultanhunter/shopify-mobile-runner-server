FROM node:20-slim

# Install runtime system dependencies for runner workflows
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libnspr4 \
    libnss3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy TypeScript config and source code
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

# Install dependencies and build
RUN npm ci
RUN npm run build

# Install ngrok once (expo tunnel)
RUN npm install -g @expo/ngrok@^4.1.0

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
