# API de logs

Endpoints para consultar los archivos Winston (`logs/combined.log`, `logs/error.log`)
sin acceso SSH. Útil cuando el bot corre en un VPS o cuando tienes varios procesos
paper en paralelo.

---

## Autenticación

Si `API_KEY` está definida en `.env`, los endpoints de logs la exigen. Si `API_KEY`
está vacía o ausente, los endpoints son públicos (solo recomendable en localhost).

**Header (recomendado):**

```http
Authorization: Bearer tu-api-key
```

**Query string (alternativa):**

```text
?token=tu-api-key
```

---

## `GET /logs`

Devuelve entradas de log filtradas, ordenadas y paginadas.

### Query parameters

| Parámetro | Default | Descripción |
|---|---|---|
| `lines` | `200` | Máximo de entradas devueltas (1–2000) |
| `order` | `desc` | `desc` = más recientes primero · `asc` = más antiguas primero |
| `from` | — | Fecha/hora mínima inclusive. `YYYY-MM-DD` o ISO (`2026-06-15T10:00:00`) |
| `to` | — | Fecha/hora máxima inclusive. `YYYY-MM-DD` usa fin del día (23:59:59.999) |
| `level` | — | Filtrar por nivel exacto: `error`, `warn`, `info`, `debug` |
| `search` | — | Subcadena en el JSON crudo o en `message` (case insensitive) |
| `file` | `combined` | `combined` o `error` |
| `format` | `json` | `json` (default) o `text` (una línea legible por entrada) |

### Respuesta JSON (default)

```json
{
  "file": "combined",
  "order": "desc",
  "filters": { "from": "2026-06-15", "to": null, "level": null, "search": null },
  "returned": 50,
  "totalMatching": 312,
  "stats": { "exists": true, "size": 1048576, "mtime": "2026-06-16T12:00:00.000Z" },
  "entries": [
    {
      "timestamp": "2026-06-16 08:00:00",
      "level": "info",
      "message": "[Momentum] Trade closed",
      "service": "binance-bot",
      "meta": { "side": "LONG" },
      "raw": "{\"timestamp\":\"...\"}"
    }
  ]
}
```

- **`totalMatching`**: cuántas entradas cumplen filtros antes del límite `lines`.
- **`returned`**: cuántas entradas vienen en `entries` (≤ `lines`).
- Con `order=desc`, `entries[0]` es la más reciente.

### Ejemplos

```bash
export HOST=http://localhost:3002
export KEY=tu-api-key

# Últimos 100 logs (más recientes primero — default)
curl -s -H "Authorization: Bearer $KEY" "$HOST/logs?lines=100" | jq

# Solo errores de hoy
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/logs?level=error&from=$(date +%F)&lines=500" | jq '.entries[].message'

# Rango de fechas, orden cronológico (para exportar a análisis)
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/logs?from=2026-06-01&to=2026-06-07&order=asc&lines=2000" | jq '.totalMatching'

# Buscar señales de una estrategia
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/logs?search=LiqRev&lines=50" | jq '.entries'

# Salida texto plano (tail legible)
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/logs?lines=30&format=text"

# Sin header, con token en query
curl -s "$HOST/logs?token=$KEY&lines=20"
```

### Errores

| Código | Causa |
|---|---|
| `401` | Falta o incorrecta la API key |
| `400` | Fecha inválida en `from` / `to` |

---

## `GET /logs/download`

Descarga el archivo de log completo o una versión filtrada.

### Query parameters

| Parámetro | Default | Descripción |
|---|---|---|
| `file` | `combined` | `combined` o `error` |
| `from`, `to`, `level`, `search`, `order` | — | Mismos filtros que `/logs`. Si alguno está presente, se descarga solo el subconjunto filtrado (texto plano, máx. 50 000 líneas) |

### Ejemplos

```bash
# Archivo completo
curl -H "Authorization: Bearer $KEY" -OJ "$HOST/logs/download"

# Solo error.log
curl -H "Authorization: Bearer $KEY" -OJ "$HOST/logs/download?file=error"

# Export filtrado por semana
curl -H "Authorization: Bearer $KEY" -OJ \
  "$HOST/logs/download?from=2026-06-01&to=2026-06-07&order=asc"
```

---

## Varios bots en paper

Cada proceso escribe en su propio `logs/combined.log` **del directorio de trabajo**
desde el que arrancó. Con `npm run paper:all`, los logs de arranque van a
`logs/paper/<estrategia>.log`; el API `/logs` de cada puerto lee el `combined.log`
local de ese proceso.

| Bot | Puerto | Logs API |
|---|---|---|
| momentum | 3002 | `http://localhost:3002/logs` |
| bounce | 3003 | `http://localhost:3003/logs` |
| liqrev | 3004 | `http://localhost:3004/logs` |
| funding | 3005 | `http://localhost:3005/logs` |

---

## Formato de timestamp

Winston escribe timestamps como `YYYY-MM-DD HH:mm:ss` (hora local del servidor).
Los filtros `from` / `to` se interpretan en la zona horaria local del proceso Node.

---

## Referencia rápida

```bash
# Errores recientes de todos los bots paper (ejemplo loop)
for port in 3002 3003 3004 3005; do
  echo "=== :$port ==="
  curl -s -H "Authorization: Bearer $KEY" \
    "http://127.0.0.1:$port/logs?level=error&lines=5&format=text"
done
```
