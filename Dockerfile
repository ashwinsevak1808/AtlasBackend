# Node 22+ is required: @supabase/supabase-js constructs a RealtimeClient on
# createClient(), which throws on startup without a native WebSocket global.
FROM node:22-alpine

# Set the working directory inside the container
WORKDIR /app

# Set default environment variables (Cloud Run or host ENV will automatically override these if set)
ENV PORT=8080 \
    NODE_ENV=production \
    FRONTEND_URL=https://getatlas.space \
    SUPABASE_URL=https://alnmebojaoxcguvsnvkn.supabase.co \
    SUPABASE_ANON_KEY=sb_publishable_Tm6IRMTUzhYI1IL9NqNPxQ_Z485J1Jt \
    DATABASE_URL=postgresql://postgres:n0y2gOSBealCjfWs@db.alnmebojaoxcguvsnvkn.supabase.co:5432/postgres


# Copy package.json and package-lock.json first to leverage Docker layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies like typescript for tsc build)
RUN npm ci --include=dev

# Copy the rest of the application files
COPY . .

# Pre-compile TypeScript to production JavaScript (outDir: ./dist)
RUN npm run build

# Expose the port that the application runs on
EXPOSE 8080

# Start the compiled production JavaScript server instantly (0.1s startup)
CMD ["node", "dist/server.js"]
