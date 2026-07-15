#!/usr/bin/env bash

resolve_service_base_url() {
  if (( $# != 2 )); then
    echo "Usage: resolve_service_base_url <service-name> <http-base-url-or-empty>" >&2
    return 2
  fi

  local service_name="$1"
  local override="$2"
  local service_command
  local listen_host='localhost'
  local listen_port='3000'

  if [[ ! "$service_name" =~ ^[a-zA-Z0-9@._-]+$ ]]; then
    echo "Unsafe service name while resolving the dashboard URL." >&2
    return 1
  fi

  if [[ -n "$override" ]]; then
    if [[ ! "$override" =~ ^http://[a-zA-Z0-9.:-]+$ ]]; then
      echo "Dashboard URL override must be a credential-free HTTP origin." >&2
      return 1
    fi
    printf '%s\n' "$override"
    return 0
  fi

  service_command="$(systemctl show "$service_name" --property=ExecStart --value)"
  if [[ -z "$service_command" ]]; then
    echo "Unable to read the $service_name service start command." >&2
    return 1
  fi

  if [[ "$service_command" =~ [[:space:]]-H[[:space:]]+([a-zA-Z0-9.:-]+) ]]; then
    listen_host="${BASH_REMATCH[1]}"
  elif [[ "$service_command" =~ [[:space:]]--hostname=([a-zA-Z0-9.:-]+) ]]; then
    listen_host="${BASH_REMATCH[1]}"
  elif [[ "$service_command" =~ [[:space:]]--hostname[[:space:]]+([a-zA-Z0-9.:-]+) ]]; then
    listen_host="${BASH_REMATCH[1]}"
  fi

  if [[ "$service_command" =~ [[:space:]]-p[[:space:]]+([0-9]{1,5}) ]]; then
    listen_port="${BASH_REMATCH[1]}"
  elif [[ "$service_command" =~ [[:space:]]--port=([0-9]{1,5}) ]]; then
    listen_port="${BASH_REMATCH[1]}"
  elif [[ "$service_command" =~ [[:space:]]--port[[:space:]]+([0-9]{1,5}) ]]; then
    listen_port="${BASH_REMATCH[1]}"
  fi

  if (( 10#$listen_port < 1 || 10#$listen_port > 65535 )); then
    echo "The $service_name service has an invalid listen port." >&2
    return 1
  fi

  case "$listen_host" in
    0.0.0.0|::) listen_host='127.0.0.1' ;;
    *:*) listen_host="[$listen_host]" ;;
  esac

  printf 'http://%s:%s\n' "$listen_host" "$listen_port"
}
