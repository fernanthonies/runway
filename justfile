# Runway — container management. Run `just` to list recipes.

default:
    @just --list

# Static files are baked into the image, so code/frontend changes
# need `just start`, not `just restart`.

# Build and start the container (rebuilds the image)
start:
    docker compose up -d --build

# Stop the container
stop:
    docker compose stop

# Restart the running container without rebuilding (config/env pickup only)
restart:
    docker compose restart

# Tail container logs
logs:
    docker compose logs -f
