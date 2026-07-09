# Plan de implementación de estrategias — especificación técnica

> Documento de referencia para implementar y comparar 4 estrategias de trading en
> Binance USDM Futures sobre el stack actual de este repositorio. Está escrito para
> que cualquier persona o IA pueda implementar cada estrategia sin contexto adicional.

---

## 0. Stack tecnológico actual (base sobre la que se implementa todo)

| Componente | Tecnología | Ubicación |
|---|---|---|
| Runtime | Node.js + TypeScript (ts-node en dev, `tsc` → `dist/` en prod) | `tsconfig.json`, `package.json` |
| Exchange REST | `binance` (npm) → `USDMClient` | `src/bot/client.ts` |
| Exchange WS | `binance` (npm) → `WebsocketClient` | `src/bot/websocket.ts` (user data), `src/bot/orderbook.ts` (market data) |
| API HTTP | Fastify (`/start`, `/stop`, `/status`, `/history`, `/logs`) | `src/api/server.ts` |
| Persistencia | PostgreSQL vía `pg` (tablas `bot_state` singleton y `trades`) | `src/db/` |
| Logs | Winston (JSON a `logs/` + consola) | `src/utils/logger.ts` |
| Tests | Node test runner (`node --test` + ts-node) | `src/bot/__tests__/` |
| Config | Variables de entorno vía dotenv | `src/bot/config.ts`, `.env` |

Convenciones existentes que TODA estrategia nueva debe respetar:

- **Serialización de operaciones**: el engine actual usa `runExclusive()` (cadena de
  promesas) para que los handlers de WS no se pisen. Reusar ese patrón.
- **Estado recuperable**: todo estado de ciclo se persiste como JSONB en
  `bot_state.orders` y se reconstruye en `syncStateWithBinance()` al reiniciar.
  Cada estrategia debe poder morir y reiniciarse sin perder la posición.
- **SL siempre en el exchange**: nunca depender solo del proceso Node para el stop.
  Usar `submitNewAlgoOrder({ algoType: 'CONDITIONAL', type: 'STOP_MARKET', closePosition: 'true' })`
  como hace `src/bot/phases/exitPhase.ts`. Existe backstop catastrófico
  (`placeCatastrophicSl`) — replicar el concepto en cada estrategia.
- **Precisión de símbolo**: leer `tickSize`, `stepSize`, `minQty`, `minNotional` de
  `getExchangeInfo()` al iniciar (ver `botEngine.init()`), redondear con
  `roundStep`/`floorStep`/`ceilStep` de `src/bot/math.ts`.
- **Fees**: `MAKER_FEE=0.0002`, `TAKER_FEE=0.0005` en config. Todo cálculo de
  rentabilidad esperada debe descontar fees de ida y vuelta.

---

## 1. Infraestructura común (implementar PRIMERO, antes de cualquier estrategia)

### 1.1 Interfaz `Strategy`

Crear `src/strategies/types.ts`:

```ts
export interface StrategyContext {
  symbol: string;
  precision: SymbolPrecision;          // de src/bot/types.ts
  client: USDMClient;                  // REST
  logger: Logger;
}

export interface Strategy {
  /** Identificador único: 'ladder' | 'funding' | 'momentum' | 'liqrev' | 'bounce' */
  readonly id: string;
  /** Carga estado desde DB, configura leverage/margin, arranca streams. */
  init(ctx: StrategyContext): Promise<void>;
  /** Comienza a buscar señales (equivalente a POST /start). */
  start(): Promise<void>;
  /** Detiene streams y cancela órdenes abiertas (equivalente a POST /stop). */
  stop(): Promise<void>;
  /** Reconcilia estado local vs exchange (llamar al reconectar WS). */
  sync(): Promise<void>;
  /** Handler de ORDER_TRADE_UPDATE del user data stream. */
  onOrderUpdate(order: Record<string, unknown>): Promise<void>;
  /** Handler de ALGO_UPDATE (SL/TP condicionales). */
  onAlgoUpdate(algo: Record<string, unknown>): Promise<void>;
  /** Snapshot para el endpoint /status. */
  getMetrics(): Record<string, unknown>;
}
```

Selección por env: `STRATEGY=ladder` (default, el bot actual envuelto en la interfaz).
`src/strategies/registry.ts` mapea id → instancia. `src/api/server.ts` y
`src/bot/websocket.ts` dejan de importar `botEngine` directamente y usan la
estrategia activa del registry.

### 1.2 Cambios de base de datos

Agregar a `src/db/schema.sql` (y un migrate correspondiente en `src/db/migrate.ts`):

```sql
-- Etiquetar cada trade con su estrategia para comparar
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'ladder';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS qty DECIMAL;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fees DECIMAL DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS funding DECIMAL DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}';

-- Registro de señales (auditables incluso si no generan trade)
CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,          -- p.ej. 'breakout_long', 'cascade_short', 'funding_open'
    payload JSONB NOT NULL,      -- valores que dispararon la señal
    acted BOOLEAN DEFAULT FALSE, -- si se convirtió en orden
    created_at TIMESTAMP DEFAULT NOW()
);

-- Curva de equity por estrategia (para Sharpe/drawdown comparables)
CREATE TABLE IF NOT EXISTS equity_snapshots (
    id SERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    balance DECIMAL NOT NULL,        -- wallet balance USDT
    unrealized DECIMAL DEFAULT 0,
    taken_at TIMESTAMP DEFAULT NOW()
);
```

Snapshot de equity: un `setInterval` cada hora que llama a
`client.getBalanceV3()` (o `getAccountInformationV3()`) y hace INSERT.

### 1.3 Modo paper trading (obligatorio para comparar sin arriesgar)

Env: `EXECUTION_MODE=live | paper`.

Crear `src/execution/executor.ts` con la interfaz:

```ts
export interface Executor {
  submitOrder(params: NewOrderParams): Promise<{ orderId: string; clientOrderId: string }>;
  submitStopMarket(params: StopParams): Promise<{ algoId: number }>;
  cancelOrder(clientOrderId: string): Promise<void>;
  getPosition(): Promise<PositionSnapshot>;
}
```

- `LiveExecutor`: delega en `USDMClient` (código actual).
- `PaperExecutor`: simula fills contra el stream `bookTicker` que ya consume
  `src/bot/orderbook.ts`:
  - Orden MARKET: fill inmediato al ask (buy) / bid (sell) + slippage fijo
    configurable `PAPER_SLIPPAGE_PCT=0.0002` + `TAKER_FEE`.
  - Orden LIMIT: se llena cuando el precio opuesto cruza el límite
    (bid ≥ limit para sell, ask ≤ limit para buy) + `MAKER_FEE`.
  - STOP_MARKET: se dispara cuando el precio toca el trigger, luego fill como MARKET.
  - Posición y balance simulados en memoria + persistidos en `bot_state.orders`
    bajo la clave `paper`.
  - Emite eventos `onOrderUpdate` sintéticos con el mismo formato que el user data
    stream para que la estrategia no distinga entre live y paper.

### 1.4 Métricas de comparación (extender `src/bot/metrics.ts`)

Para cada estrategia, calcular sobre `trades WHERE strategy = $1`:

- `expectancy` (ya existe), `profitFactor` = Σganancias / |Σpérdidas|
- `maxDrawdown` sobre `equity_snapshots` (peak-to-trough)
- `sharpeDaily` = mean(retornos diarios) / std(retornos diarios) × √365
- `feesTotal`, `fundingTotal` (de las nuevas columnas)
- `exposureHours` = Σ(closed_at − opened_at)
- `tradesPerWeek`

Nuevo endpoint: `GET /compare` → tabla con estas métricas por estrategia.

### 1.5 Criterios de comparación (protocolo fijo, decidido ANTES de mirar resultados)

1. Cada estrategia corre mínimo **8 semanas o 100 trades** (lo que ocurra después)
   en paper o testnet con el mismo capital inicial simulado.
2. Se descarta una estrategia si: maxDrawdown > 15% del capital, o profitFactor < 1.1
   tras el mínimo de muestra.
3. Se promociona a capital real pequeño (≤10% del capital) la que tenga mejor
   Sharpe con profitFactor ≥ 1.3.
4. Ninguna estrategia se optimiza mirando los datos del período de evaluación
   (si se re-parametriza, el reloj vuelve a cero).

---

## 2. Estrategia A — `funding`: Delta-neutral de funding rate

### 2.1 Cómo opera (para humanos)

En los futuros perpetuos, cada 8 horas los longs pagan a los shorts (o al revés)
una tasa de funding que mantiene el perpetuo pegado al spot. Cuando el mercado está
eufórico, el funding se vuelve muy positivo: estar short en el perpetuo **cobra**
esa tasa. La estrategia abre short en el perpetuo y compra la misma cantidad en
spot: el PnL de precio se cancela (delta neutral) y queda solo el ingreso por
funding. No predice precio; cosecha una tasa observable.

### 2.2 Fundamento del edge

- El funding es público, medible y persistente en rachas (autocorrelación alta).
- El riesgo no es direccional: es de base (divergencia perp-spot) y de ejecución.
- Edge bruto = funding cobrado − fees de 4 patas (abrir/cerrar perp y spot) − basis.

### 2.3 Datos necesarios

| Dato | Fuente | Método del paquete `binance` |
|---|---|---|
| Funding actual + próximo timestamp | REST USDM | `client.getMarkPrice({ symbol })` → `lastFundingRate`, `nextFundingTime` |
| Historial de funding | REST USDM | `client.getFundingRateHistory({ symbol, limit: 1000 })` |
| Funding en vivo | WS | stream `markPriceUpdate` (campo `r`) — ya se consume en `src/bot/orderbook.ts` |
| Ingresos por funding realizados | REST USDM | `client.getIncomeHistory({ symbol, incomeType: 'FUNDING_FEE' })` |
| Trading spot | REST Spot | **`MainClient`** del mismo paquete `binance` (nuevo: `src/bot/spotClient.ts`) |

> Nota: requiere habilitar spot trading en la API key y tener USDT en la wallet
> spot además de la de futuros. Verificar métodos exactos del `MainClient`
> (`submitNewOrder` con `symbol: 'ETHUSDT'`) contra la versión instalada del paquete.

### 2.4 Parámetros (`.env`)

```bash
FUNDING_SYMBOL=ETHUSDT
FUNDING_ENTRY_APR=0.15        # abrir si APR anualizado > 15%
FUNDING_EXIT_APR=0.05         # cerrar si APR < 5% durante FUNDING_EXIT_WINDOWS
FUNDING_ENTRY_WINDOWS=2       # nº de ventanas de 8h consecutivas sobre el umbral antes de abrir
FUNDING_EXIT_WINDOWS=3        # nº de ventanas bajo el umbral antes de cerrar
FUNDING_NOTIONAL_PCT=0.5      # fracción del capital dedicada (por pata)
FUNDING_MAX_LEVERAGE=2        # leverage de la pata perp (bajo: el riesgo es liquidación)
FUNDING_REBALANCE_DRIFT=0.02  # rebalancear si |delta| > 2% del notional
```

Conversión: `APR = rate_8h × 3 × 365`. Ejemplo: rate 0.01%/8h → APR ≈ 10.95%.

### 2.5 Máquina de estados

```
IDLE → (APR > entry durante N ventanas) → OPENING → NEUTRAL → (APR < exit durante M ventanas) → CLOSING → IDLE
```

- **IDLE**: cada 15 min, leer `getMarkPrice` y evaluar regla de entrada.
  Registrar cada evaluación en la tabla `signals` (kind `funding_eval`).
- **OPENING** (atómico, con rollback):
  1. `qty = floorStep((balance × FUNDING_NOTIONAL_PCT) / precio, stepSize)`.
  2. Comprar spot: `MainClient.submitNewOrder({ side: 'BUY', type: 'MARKET', quantity: qty })`.
  3. Short perp: `USDMClient.submitNewOrder({ side: 'SELL', type: 'MARKET', quantity: qty })`.
  4. Si la pata 3 falla → vender el spot inmediatamente y volver a IDLE (log error).
  5. Persistir `{ spotQty, perpQty, entryBasis, openedAt }` en `bot_state.orders.funding`.
- **NEUTRAL**:
  - Cada hora: registrar funding acumulado (`getIncomeHistory`), verificar drift
    (`|spotQty − perpQty| / perpQty > FUNDING_REBALANCE_DRIFT` → ajustar la pata perp).
  - Vigilar margen de la pata perp: si `marginRatio > 0.5` → reducir ambas patas 25%.
- **CLOSING**: cerrar perp (BUY MARKET reduceOnly) y vender spot, guardar trade con
  `pnl = funding_total + basis_pnl − fees`, `strategy = 'funding'`.

### 2.6 Riesgos y casos borde

- **No hay SL de precio**: la posición es neutral. El riesgo real es la liquidación
  de la pata perp en un pump violento → por eso leverage ≤ 2 y monitoreo de margen.
- Funding puede volverse negativo entre evaluaciones: el histéresis de
  `FUNDING_EXIT_WINDOWS` evita abrir/cerrar en cada flip (los fees de 4 patas
  cuestan ~0.14% del notional por ciclo completo con taker).
- Regla de oro pre-entrada: `APR_esperado × días_estimados > fees_ciclo × 3`.

### 2.7 Archivos a crear

```
src/strategies/funding/index.ts        # clase FundingStrategy implements Strategy
src/strategies/funding/rules.ts        # funciones puras: shouldOpen, shouldClose, computeApr, needsRebalance
src/bot/spotClient.ts                  # MainClient singleton
src/bot/__tests__/fundingRules.test.ts # tests de las funciones puras con historiales sintéticos
```

### 2.8 Tests unitarios mínimos

- `computeApr(0.0001) ≈ 0.1095`.
- `shouldOpen` exige N ventanas consecutivas (una sola no abre).
- `needsRebalance` con drift 2.1% → true; 1.9% → false.
- Rollback: simular fallo de la pata perp y verificar que ordena venta del spot.

---

## 3. Estrategia B — `momentum`: Breakout con skew positivo

### 3.1 Cómo opera

Compra rupturas de máximos y vende rupturas de mínimos en timeframe 1h, con stop
inicial basado en ATR y trailing stop amplio. Pierde poco muchas veces y gana mucho
pocas veces (lo inverso del bot actual). En crypto los movimientos direccionales
son violentos y persistentes; el objetivo es capturar la cola derecha.

### 3.2 Datos necesarios

| Dato | Fuente | Método |
|---|---|---|
| Velas 1h históricas (warm-up) | REST | `client.getKlines({ symbol, interval: '1h', limit: 300 })` |
| Velas 1h en vivo | WS | `wsClient.subscribeKlines(symbol, '1h', 'usdm')` — actuar SOLO en vela cerrada (`k.x === true`) |
| Precio actual | Ya existe | `orderBookCollector.currentPrice` |

Indicadores a implementar en `src/strategies/momentum/indicators.ts` (funciones
puras, sin librerías externas):

```ts
atr(candles: Candle[], period = 14): number            // Wilder smoothing
donchianHigh(candles: Candle[], period = 20): number   // máximo de los últimos N highs (excluyendo vela actual)
donchianLow(candles: Candle[], period = 20): number
adx(candles: Candle[], period = 14): number            // filtro de régimen
```

### 3.3 Parámetros (`.env`)

```bash
MOM_INTERVAL=1h
MOM_DONCHIAN_PERIOD=20
MOM_ATR_PERIOD=14
MOM_ATR_STOP_MULT=2.0        # stop inicial = 2×ATR desde la entrada
MOM_ATR_TRAIL_MULT=3.0       # trailing chandelier = 3×ATR desde el extremo favorable
MOM_ADX_MIN=20               # no operar si ADX < 20 (sin tendencia)
MOM_RISK_PCT=0.01            # riesgo por trade = 1% del balance
MOM_MAX_CONSECUTIVE_LOSSES=6 # circuit breaker: pausar 24h tras 6 pérdidas seguidas
MOM_FUNDING_VETO_APR=0.30    # no abrir long si funding APR > 30% (euforia) ni short si < −30%
```

### 3.4 Reglas exactas

**Entrada (evaluar solo al cierre de cada vela 1h):**

```
LONG  si: close > donchianHigh(20)  Y  adx(14) ≥ MOM_ADX_MIN  Y  funding no veta
SHORT si: close < donchianLow(20)   Y  adx(14) ≥ MOM_ADX_MIN  Y  funding no veta
```

- Ejecución: MARKET al cierre confirmado de la vela (simple y robusto).
- Solo una posición a la vez. Si hay señal contraria con posición abierta → cerrar
  y abrir la contraria (stop-and-reverse opcional, fase 2; en fase 1 solo cerrar).

**Sizing:**

```
stopDistance = MOM_ATR_STOP_MULT × atr
qty = floorStep((balance × MOM_RISK_PCT) / stopDistance, stepSize)
Validar qty ≥ minQty y qty × price ≥ minNotional; si no, no operar.
```

**Salidas:**

1. SL inicial: STOP_MARKET (algo order, `closePosition: 'true'`) a
   `entry − dir × stopDistance`.
2. Trailing (al cierre de cada vela): `trailStop = extremoFavorable − dir × MOM_ATR_TRAIL_MULT × atr`.
   Si mejora el stop actual en ≥ 1 tick → cancelar algo y re-colocar (mismo patrón
   que `evaluateHarvestTrail` en `src/bot/phases/harvestTrail.ts`).
   El stop nunca retrocede.
3. Sin take profit fijo. La salida es siempre por stop.

**Estado persistido** (`bot_state.orders.momentum`):
`{ side, qty, entry, stopPrice, slAlgoId, extremeFavorable, openedAt, consecutiveLosses, pausedUntil }`.

### 3.5 Casos borde

- Reinicio del proceso: `sync()` reconstruye desde `getPosition()` + algo orders
  abiertas; si hay posición sin SL → colocarlo inmediatamente (reusar patrón backstop).
- Vela de ruptura gigante (> 4×ATR): saltar la señal (probable exhaustión, el stop
  quedaría demasiado lejos).
- Circuit breaker: tras `MOM_MAX_CONSECUTIVE_LOSSES` pérdidas seguidas, `pausedUntil = now + 24h`.

### 3.6 Archivos y tests

```
src/strategies/momentum/index.ts
src/strategies/momentum/indicators.ts     # atr, donchian, adx (puras)
src/strategies/momentum/rules.ts          # evaluateEntry, computeTrailStop, shouldPause (puras)
src/bot/__tests__/momentumIndicators.test.ts  # ATR/ADX contra valores calculados a mano
src/bot/__tests__/momentumRules.test.ts       # breakout sí/no, veto ADX, veto funding, trailing nunca retrocede
```

---

## 4. Estrategia C — `liqrev`: Reversión tras cascada de liquidaciones

### 4.1 Cómo opera

Cuando el precio cae rápido, las liquidaciones forzadas de longs venden a mercado,
lo que empuja más el precio y liquida a más longs (cascada). Ese exceso de venta es
**forzado, no informado** — al agotarse, el precio suele revertir parcialmente.
La estrategia detecta la cascada en vivo (stream de liquidaciones), espera el
agotamiento y entra contra el movimiento con stop bajo el extremo.

A diferencia de los "muros" del libro (cancelables, spoofeables), una liquidación
ejecutada es información real e imposible de fingir.

### 4.2 Datos necesarios

| Dato | Fuente | Método |
|---|---|---|
| Liquidaciones en vivo | WS | stream `<symbol>@forceOrder` — en el paquete: `wsClient.subscribeAllLiquidationOrders('usdm')` y filtrar por símbolo (verificar nombre exacto del método en la versión instalada) |
| Trades agresivos (CVD) | WS | `wsClient.subscribeAggregateTrades(symbol, 'usdm')` — campo `m`: true = agresión vendedora |
| ATR 1m (contexto de volatilidad) | REST + WS | `getKlines({ interval: '1m' })` + kline stream 1m |

**Advertencia**: Binance emite máximo una liquidación por segundo por símbolo en
este stream (es una muestra, no el total). Suficiente como señal, insuficiente
como medida exacta del volumen liquidado.

### 4.3 Estructuras en memoria

`src/strategies/liqrev/cascadeDetector.ts` (funciones puras + una clase con ventanas):

- Ventana deslizante de 60s de liquidaciones: `{ side, notional, ts }[]`.
- Distribución de referencia: suma de notional liquidado por ventana de 60s durante
  las últimas 24h (array circular de 1440 valores) → percentil 99 como umbral.
- CVD por minuto de los últimos 15 min.

### 4.4 Parámetros (`.env`)

```bash
LIQREV_WINDOW_SEC=60
LIQREV_PERCENTILE=0.99          # umbral de cascada sobre distribución 24h
LIQREV_MIN_NOTIONAL=500000      # piso absoluto USD de liquidaciones en la ventana
LIQREV_PRICE_MOVE_ATR=3         # el precio debe haberse movido ≥ 3×ATR(1m) en la dirección de la cascada
LIQREV_EXHAUST_SEC=45           # segundos sin nuevas liquidaciones ni nuevo extremo = agotamiento
LIQREV_RISK_PCT=0.01
LIQREV_SL_BUFFER_ATR=0.5        # SL = extremo de la cascada − 0.5×ATR(1m)
LIQREV_TP_RETRACE=0.5           # TP = 50% de retroceso del rango de la cascada
LIQREV_TIME_STOP_MIN=45         # cerrar a mercado si no tocó TP ni SL en 45 min
LIQREV_COOLDOWN_MIN=30          # tras un trade, ignorar señales 30 min
```

### 4.5 Máquina de estados y reglas exactas

```
WATCHING → (cascada detectada) → ARMED → (agotamiento confirmado) → ENTERING → IN_POSITION → EXITED → WATCHING
```

**Detección de cascada (en WATCHING, en cada evento de liquidación):**

```
liqNotional60s(side=SELL) > max(percentil99_24h, LIQREV_MIN_NOTIONAL)
Y (precioActual − precioHace60s) ≤ −LIQREV_PRICE_MOVE_ATR × ATR1m
→ cascada bajista detectada; registrar low de la cascada; pasar a ARMED
```

(Espejo para cascada alcista con liquidaciones de shorts.)

**Confirmación de agotamiento (en ARMED, evaluar cada tick de precio):**

```
1. Han pasado ≥ LIQREV_EXHAUST_SEC segundos sin nuevas liquidaciones del lado de la cascada
2. Y el precio no hizo nuevo extremo en esos segundos
3. Y CVD del último minuto cambió de signo (agresión compradora neta tras cascada bajista)
→ entrar LONG a mercado
Si en 10 min no se confirma → volver a WATCHING (señal expirada; registrar en signals con acted=false)
```

**Gestión:**

```
SL  = cascadeLow − LIQREV_SL_BUFFER_ATR × ATR1m      (STOP_MARKET closePosition)
TP  = entry + LIQREV_TP_RETRACE × (cascadeStart − cascadeLow)   (LIMIT reduceOnly)
qty = floorStep((balance × LIQREV_RISK_PCT) / (entry − SL), stepSize)
Time stop: MARKET reduceOnly a los LIQREV_TIME_STOP_MIN minutos.
```

### 4.6 Casos borde

- Segunda pata de la cascada: si estando ARMED aparecen nuevas liquidaciones
  masivas, resetear el reloj de agotamiento y actualizar el extremo.
- Reinicio en ARMED: no persistir ARMED; al reiniciar siempre WATCHING (la ventana
  de 24h se reconstruye; aceptar que el umbral es impreciso la primera hora — usar
  `LIQREV_MIN_NOTIONAL` como piso mientras tanto).
- Este es el único caso donde SÍ conviene registrar TODAS las señales no ejecutadas
  en `signals`: la frecuencia de cascadas es baja (pocas por semana) y cada una es
  oro para calibrar.

### 4.7 Archivos y tests

```
src/strategies/liqrev/index.ts
src/strategies/liqrev/cascadeDetector.ts   # ventanas, percentiles, agotamiento (puras/testeables)
src/strategies/liqrev/cvd.ts               # acumulador de CVD desde aggTrades
src/bot/__tests__/cascadeDetector.test.ts  # secuencias sintéticas de liquidaciones: detecta/no detecta, agotamiento, segunda pata
src/bot/__tests__/cvd.test.ts
```

---

## 5. Estrategia D — `bounce`: Rebote en zona de liquidez con confirmación (evolución del bot actual)

### 5.1 Cómo opera y en qué se diferencia del bot actual

Mantiene la hipótesis de las zonas de liquidez pero corrige los tres defectos:

| Bot actual (`ladder`) | `bounce` |
|---|---|
| Límite pasivo EN el muro (fill = el precio te atravesó) | Espera **rechazo confirmado** de la zona antes de entrar |
| Muro = snapshot instantáneo (spoofeable) | Muro = **persistencia** medida durante toda la ventana |
| Promedia con tamaño creciente (martingala) | Tamaño fijo; agrega solo **a favor** (anti-martingala) |

### 5.2 Detección de zonas con persistencia

Modificar el uso de `orderBookCollector` (el colector diff-depth ya existe, solo
cambia la agregación):

- Cada 10 s durante la ventana de colección (10 min), tomar `getWalls()` y guardar
  el snapshot en un buffer (60 muestras).
- **Zona válida** = bucket que aparece en ≥ `BOUNCE_WALL_PRESENCE=0.7` (70%) de las
  muestras con volumen ≥ `BOUNCE_WALL_MIN_RATIO=3` veces la mediana de profundidad
  por bucket.
- Score de zona = presencia × volumen_promedio. Máximo 3 zonas por lado.
- Re-validación en vivo: al armarse un setup, verificar que la zona sigue teniendo
  ≥ 50% del volumen medido; si no → descartar setup (el muro se retiró).

Implementar en `src/strategies/bounce/wallPersistence.ts` (funciones puras sobre
arrays de snapshots — no toca el colector).

### 5.3 Parámetros (`.env`)

```bash
BOUNCE_WALL_PRESENCE=0.7
BOUNCE_WALL_MIN_RATIO=3
BOUNCE_ZONE_TOUCH_PCT=0.001     # "tocó la zona" = precio a ≤0.1% del borde
BOUNCE_CONFIRM_REBOUND_PCT=0.0015  # rebote mínimo 0.15% desde el extremo del toque
BOUNCE_CONFIRM_CVD=true         # exigir CVD 1m a favor del rebote
BOUNCE_RISK_PCT=0.01
BOUNCE_SL_ATR_BUFFER=0.5        # SL = borde exterior de la zona − 0.5×ATR(1m)
BOUNCE_MAX_ADDS=2               # máximo de agregados anti-martingala
BOUNCE_ADD_TRIGGER_R=0.5        # agregar solo con posición ≥ +0.5R
BOUNCE_ADD_SIZE_RATIO=0.5       # cada agregado = 50% del tamaño inicial
BOUNCE_SETUP_TTL_MIN=30         # setup expira si no confirma en 30 min
```

### 5.4 Máquina de estados y reglas exactas

```
COLLECTING (10 min) → ZONES_READY → (precio toca zona) → SETUP → (confirmación) → IN_POSITION → EXITED → COLLECTING
```

**SETUP (por tick, ya throttleado a 5 s en el patrón actual):**

```
touch      = precio entró a ≤ BOUNCE_ZONE_TOUCH_PCT del borde de una zona bid (para LONG)
extreme    = mínimo alcanzado durante el toque
confirmado = precio ≥ extreme × (1 + BOUNCE_CONFIRM_REBOUND_PCT)
             Y (si BOUNCE_CONFIRM_CVD) CVD_1m > 0
             Y re-validación: la zona conserva ≥50% de su volumen
→ entrar LONG con LIMIT post-only al bid (timeInForce 'GTX'); si no llena en 10 s, MARKET
```

**Gestión:**

```
SL inicial = bordeExteriorZona − BOUNCE_SL_ATR_BUFFER × ATR1m   (STOP_MARKET closePosition)
qty        = floorStep((balance × BOUNCE_RISK_PCT) / (entry − SL), stepSize)
Breakeven  : al llegar a +0.75% mover SL a entry + fees (reusar computeHarvestSlPrice
             y evaluateHarvestTrail de src/bot/phases/, que ya implementan esto)
Trailing   : idéntico al harvest actual (HARVEST_TRAIL_PCT)
Agregados  : si posición ≥ +BOUNCE_ADD_TRIGGER_R × R  Y  hay nueva confirmación de
             rebote en zona superior → agregar BOUNCE_ADD_SIZE_RATIO × qty inicial
             (máx BOUNCE_MAX_ADDS). El SL de toda la posición nunca baja.
Sin TP fijo: la salida es breakeven/trailing (deja correr el rebote grande).
```

**Aborto de posición**: si la zona de origen pierde >50% de su volumen con la
posición abierta y aún sin breakeven → cerrar a mercado (el soporte se retiró).

### 5.5 Reutilización del código actual

| Pieza existente | Se reutiliza en `bounce` |
|---|---|
| `src/bot/orderbook.ts` (diff-depth sync + bookTicker) | Tal cual |
| `src/bot/phases/exitPricing.ts` (`computeHarvestSlPrice`, catastrófico) | Tal cual |
| `src/bot/phases/harvestTrail.ts` (`evaluateHarvestTrail`) | Generalizar: extraer a `src/strategies/shared/trailing.ts` |
| `src/bot/exchange.ts` (getPosition, cancelaciones, sync) | Tal cual |
| `src/bot/ladder/*` (escalera martingala) | **No se usa** |
| CVD | Compartido con `liqrev` (`src/strategies/liqrev/cvd.ts` → mover a `shared/`) |

### 5.6 Tests

```
src/bot/__tests__/wallPersistence.test.ts  # snapshots sintéticos: muro persistente vs muro que aparece 1 vez
src/bot/__tests__/bounceRules.test.ts      # toque, rebote insuficiente, CVD en contra, zona retirada, anti-martingala nunca agrega en pérdida
```

---

## 6. Orden de implementación recomendado

1. **Infraestructura común** (sección 1): interfaz Strategy + columnas DB +
   PaperExecutor + `/compare`. Sin esto no hay comparación honesta.
   El bot actual se envuelve como `LadderStrategy` sin cambiar su lógica.
2. **`momentum`** — la más simple (velas cerradas, sin streams nuevos complejos),
   valida toda la infraestructura común.
3. **`bounce`** — reutiliza el máximo del código existente, corrige el diseño actual.
4. **`liqrev`** — requiere el stream de liquidaciones y calibración de umbrales.
5. **`funding`** — requiere spot client y wallet spot (más setup operativo, pero la
   lógica es la más simple de todas).

Cada estrategia se desarrolla en paper mode primero. Las 4 + `ladder` corren en
paralelo en paper (procesos separados con `STRATEGY=x EXECUTION_MODE=paper PORT=300x`)
alimentando las mismas tablas, y `/compare` responde la pregunta con datos.

## 7. Reglas no negociables (aplican a las 4)

1. SL en el exchange siempre, con backstop catastrófico si el SL "bueno" no se puede colocar.
2. Riesgo por trade ≤ 1% del balance (`*_RISK_PCT`), sin excepciones ni martingala.
3. Circuit breaker global: pérdida diaria > 3% del balance → `stop()` + estado STOPPED (requiere intervención manual).
4. Toda señal (ejecutada o no) se registra en `signals` — sin eso no se puede calibrar después.
5. Ningún parámetro se cambia durante el período de evaluación.
