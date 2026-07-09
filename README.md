# binance-bot-2

Bot multi-estrategia para **Binance USDM Futures** en TypeScript. Corre una estrategia
por proceso, con modo **paper trading** (fills simulados contra el book real) y métricas
de comparación entre estrategias en una base Postgres compartida.

| Estrategia | Estado | Descripción corta |
|---|---|---|
| `ladder` | ✅ Implementada | Straddle en muros de liquidez del order book + escalera DCA con SL de riesgo fijo y harvest con breakeven/trailing |
| `momentum` | ✅ Implementada | Breakout de canales Donchian (1h) con filtro ADX, stop 2×ATR y trailing chandelier 3×ATR |
| `bounce` | ✅ Implementada | Rebote en zonas de liquidez persistentes con confirmación CVD, anti-martingala y trailing/breakeven |
| `liqrev` | ✅ Implementada | Reversión tras cascadas de liquidaciones (paper + live) |
| `funding` | ✅ Implementada | Delta-neutral cosechando funding rate (paper + live) |

La especificación completa de cada estrategia está en
[`docs/estrategias-plan-implementacion.md`](docs/estrategias-plan-implementacion.md).

Para **iterar con IA sin perder contexto** (arquitectura, convenciones, mapa de archivos,
checklist): [`docs/REFERENCIA-IA-ESTRATEGIAS.md`](docs/REFERENCIA-IA-ESTRATEGIAS.md).

---

## Requisitos

- **Node.js** ≥ 20 (se usa `node --test` y ts-node)
- **PostgreSQL** ≥ 13 corriendo localmente o accesible por red
- Cuenta de Binance con API key de **futuros USDM** (para paper trading solo se usa
  para leer datos de mercado y el user data stream)

## Instalación

```bash
git clone <repo>
cd binance-bot-2
npm install
```

### 1. Base de datos

```bash
createdb binance-bot-2          # o crearla con tu cliente favorito
npm run db:init                 # crea tablas (bot_state, trades, signals, equity_snapshots)
npm run db:migrate              # aplica columnas/tablas nuevas sobre una DB existente
```

### 2. Variables de entorno (por capas)

La configuración se resuelve en **3 capas**, de mayor a menor prioridad:

```
1. Variables reales del entorno   → STRATEGY=momentum PORT=3002 npm start
2. .env.<estrategia>              → .env.ladder, .env.momentum, ... (parámetros del bot)
3. .env                           → base compartida (DB, API keys, símbolo, fees)
```

Setup inicial:

```bash
cp .env.example .env                        # completar DATABASE_URL y claves de Binance
cp .env.ladder.example .env.ladder          # parámetros del bot ladder
cp .env.momentum.example .env.momentum      # parámetros del bot momentum
cp .env.bounce.example .env.bounce          # parámetros del bot bounce
```

El overlay se elige con la variable `STRATEGY`: si `STRATEGY=momentum`, se carga
`.env.momentum` encima de `.env`. Así cada bot tiene su propio archivo de parámetros
y puertos sin duplicar secretos. Los archivos `.env*` reales están gitignoreados;
solo los `*.example` se commitean.

### 3. Verificar conexión

```bash
npm run test:connections
```

## Correr los bots

Cada estrategia es **un proceso** con su propio puerto HTTP. Todos comparten la misma
DB, lo que permite compararlas con `GET /compare`.

```bash
# Bot ladder (estrategia original) en live — puerto 3001
STRATEGY=ladder npm start

# Bot momentum en paper trading — puerto 3002 (definido en .env.momentum)
STRATEGY=momentum npm start

# Bot bounce en paper — puerto 3003 (definido en .env.bounce)
STRATEGY=bounce npm start

# Override puntual por CLI (gana sobre los .env)
STRATEGY=momentum EXECUTION_MODE=paper PORT=3005 npm start
```

El proceso arranca el servidor HTTP e inicializa la estrategia, pero **no opera hasta
recibir `POST /start`**:

```bash
curl -X POST http://localhost:3002/start    # empezar a operar
curl -X POST http://localhost:3002/stop     # parar (en paper no afecta a los otros bots)
```

### Comparación en paper (las 4 estrategias a la vez)

Para recopilar trades/señales y comparar modelos sin arriesgar capital:

```bash
cp .env.momentum.example .env.momentum   # repetir: bounce, liqrev, funding
npm run paper:all                        # levanta momentum:3002, bounce:3003, liqrev:3004, funding:3005
curl http://localhost:3002/compare       # métricas agregadas por estrategia
npm run paper:stop                       # detiene los 4 procesos
```

Logs por bot en `logs/paper/<estrategia>.log`. PIDs en `.paper-bots.pids`.

> En paper, `POST /stop` solo para **ese** proceso; el status global `RUNNING` se
> mantiene para que los demás sigan evaluando señales.

### Modos de ejecución

- `EXECUTION_MODE=live` — órdenes reales en el exchange.
- `EXECUTION_MODE=paper` — fills simulados contra el bid/ask real del bookTicker
  (balance inicial `PAPER_INITIAL_BALANCE`, slippage `PAPER_SLIPPAGE_PCT`).
  Soportado por las estrategias nuevas; para `ladder` usar `USE_TESTNET=true` como
  entorno de pruebas.

### Producción: build y PM2

En producción se compila TypeScript a JavaScript (`dist/`) y se ejecuta con Node
directo (sin ts-node). [PM2](https://pm2.keymetrics.io/) mantiene los procesos vivos,
reinicia tras caídas y centraliza logs.

#### 1. Build

```bash
cd /ruta/a/binance-bot-2

npm ci                    # o npm install
npm run db:migrate        # si la DB ya existe y hubo cambios de schema
npm run build             # compila src/ → dist/
```

Verifica que exista `dist/api/server.js`:

```bash
ls dist/api/server.js
npx tsc --noEmit          # opcional: type-check sin emitir
```

Prueba manual antes de PM2:

```bash
STRATEGY=momentum EXECUTION_MODE=paper PORT=3002 npm run start:prod
curl http://localhost:3002/status
```

#### 2. Instalar PM2

```bash
npm install -g pm2
# o sin global: npx pm2 ...
```

Crea la carpeta de logs de PM2 (el ecosystem la referencia):

```bash
mkdir -p logs/pm2
```

#### 3. Arrancar con PM2

El repo incluye `ecosystem.config.cjs` con **un proceso por estrategia**:

| Proceso PM2 | STRATEGY | Puerto | Modo |
|---|---|---|---|
| `bot-ladder` | ladder | 3001 | live |
| `bot-momentum` | momentum | 3002 | paper |
| `bot-bounce` | bounce | 3003 | paper |
| `bot-funding` | funding | 3005 | paper |
| `bot-liqrev` | liqrev | 3004 | paper |

```bash
# Todos los bots del ecosystem
pm2 start ecosystem.config.cjs

# Solo algunos
pm2 start ecosystem.config.cjs --only bot-momentum,bot-bounce

# Estado, logs, reinicio
pm2 status
pm2 logs bot-momentum
pm2 logs --lines 100
pm2 restart bot-momentum
pm2 stop all
pm2 delete all
```

PM2 **no** llama a `POST /start` automáticamente. Tras levantar los procesos, activa
cada bot (o la flota paper):

```bash
curl -X POST http://localhost:3002/start
curl -X POST http://localhost:3003/start
# … o en loop:
for port in 3002 3003 3004 3005; do curl -sf -X POST "http://127.0.0.1:$port/start"; done
```

#### 4. Persistir PM2 tras reinicio del servidor

```bash
pm2 save
pm2 startup    # sigue las instrucciones que imprime (sudo env PATH=...)
```

#### 5. Desplegar una nueva versión

```bash
git pull
npm ci
npm run build
pm2 reload ecosystem.config.cjs --update-env
# o por bot:
pm2 reload bot-momentum --update-env
```

#### 6. Variables de entorno con PM2

Orden de prioridad (igual que en desarrollo):

1. `env` en `ecosystem.config.cjs` (STRATEGY, PORT, EXECUTION_MODE)
2. Variables que exportes antes de `pm2 start`
3. `.env.<strategy>` según `STRATEGY`
4. `.env` base (DATABASE_URL, BINANCE_API_KEY, …)

Los archivos `.env` deben estar en la **raíz del repo** (`cwd` del proceso). No
commitear secretos.

Para **live** en momentum/bounce/etc., cambia `EXECUTION_MODE: 'live'` en el
`env` del app correspondiente en `ecosystem.config.cjs`.

#### 7. Un solo bot sin editar el ecosystem

```bash
cd /ruta/a/binance-bot-2
STRATEGY=momentum EXECUTION_MODE=paper PORT=3002 NODE_ENV=production \
  pm2 start dist/api/server.js --name bot-momentum
```

Recomendado: `pm2 start ecosystem.config.cjs --only bot-momentum`.




## API HTTP

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/start` | Empieza a operar (estado RUNNING) |
| POST | `/stop` | Para y cancela órdenes abiertas |
| GET | `/status` | Estado vivo: estrategia, modo, posición, stops, performance |
| GET | `/compare` | Tabla comparativa por estrategia: expectancy, profit factor, drawdown, Sharpe, fees |
| GET | `/history` | Últimos 100 trades |
| GET | `/logs` | Logs filtrados y ordenados — ver [`docs/api-logs.md`](docs/api-logs.md) |
| GET | `/logs/download` | Descarga completa o filtrada del archivo de log |

Consulta detallada (filtros por fecha, orden, ejemplos curl):
[`docs/api-logs.md`](docs/api-logs.md).

```bash
# Últimos 50 logs, más recientes primero (default order=desc)
curl -H "Authorization: Bearer $API_KEY" "http://localhost:3002/logs?lines=50"

# Errores de un día concreto
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3002/logs?level=error&from=2026-06-15&to=2026-06-15"
```

## Tests

```bash
npm test             # suite completa (node --test, sin red)
npx tsc --noEmit     # type-check
```

> Nota: algunos tests de geometría del ladder son sensibles a valores extremos en tu
> `.env` local (p. ej. `MIN_SL_GAP_TICKS` muy alto los hace fallar). Los defaults de
> los `*.example` pasan la suite completa.

## Estructura del proyecto

```
src/
├── api/           servidor Fastify (/start, /stop, /status, /compare, /logs)
├── bot/           motor de la estrategia ladder (fases, escalera, order book, exits)
├── config/        carga de env por capas (.env + .env.<estrategia>)
├── db/            schema.sql, init, migraciones, pool pg
├── execution/     abstracción de ejecución: LiveExecutor / PaperExecutor
├── monitor/       snapshots de equity para /compare
├── strategies/    interfaz Strategy, registry y estrategias (ladder, momentum, ...)
└── utils/         logger Winston
docs/              especificación de estrategias y plan de implementación
ecosystem.config.cjs   PM2: un proceso por estrategia (producción)
```

## Advertencias

- Esto opera futuros con apalancamiento: **puede perder dinero real**. Toda estrategia
  nueva debe pasar por paper trading y superar los criterios de `/compare` (mínimo
  8 semanas o 100 trades, profit factor ≥ 1.3, drawdown < 15%) antes de tocar capital.
- El stop loss vive **en el exchange** (con backstop catastrófico), pero si detienes
  el bot con posición abierta las órdenes se cancelan y la posición queda manual.
- Nunca commitear `.env*` (solo los `*.example`).


Lee docs/REFERENCIA-IA-ESTRATEGIAS.md y docs/estrategias-plan-implementacion.md.
Estrategia: momentum. Objetivo: <tu cambio>.
