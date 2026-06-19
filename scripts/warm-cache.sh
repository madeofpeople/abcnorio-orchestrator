#!/bin/bash
set -e

HOST="${PRODUCTION_HOST}"

URLS=(
    "${HOST}/events/listing?date-filter=ongoing-and-upcoming&order=desc"
    "${HOST}/events/listing?date-filter=ongoing-and-upcoming&order=asc"
    "${HOST}/events/listing?date-filter=past&order=desc"
    "${HOST}/events/listing?date-filter=upcoming&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=punk-hardcore-collective&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=visual-arts-collective&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=zine-library-collective&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=darkroom-collective&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=silkscreen-printshop&order=desc"
    "${HOST}/events/listing?date-filter=&event_type=&collective_association=computer-center&order=desc"
    "${HOST}/search/api?q=show"
    "${HOST}/search/api?q=exhibit"
    "${HOST}/search/api?q=punk"
)

echo "Warming production cache: $HOST"

for url in "${URLS[@]}"; do
    status=$(curl -sf -o /dev/null -w "%{http_code}" \
        -H "HX-Request: true" \
        -H "HX-Target: event-listing" \
        "$url" 2>/dev/null || echo "ERR")
    echo "  $status  $url"
done

echo "Cache warm done."
