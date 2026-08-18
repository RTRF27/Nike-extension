---
name: sneakerbot
description: Drive a locally-running SneakerBot instance (samc621/SneakerBot) over its HTTP API — manage checkout tasks, proxies, and billing/shipping addresses for nike, footsites, shopify, demandware, and supremenewyork. Use when asked to create, list, update, start, or stop SneakerBot tasks, register proxies, or add addresses. Not for the Nike-extension Chrome extension itself.
---

# SneakerBot API

Wrapper for the Express API exposed by [samc621/SneakerBot](https://github.com/samc621/SneakerBot).

> **This skill was authored locally**, not shipped by the upstream repo. SneakerBot contains no
> `SKILL.md` or agent metadata — it is a standalone Node/Puppeteer service. This file wraps its
> HTTP surface so an agent can operate it. Upstream is MIT (Samuel Corso, 2021).

## Preconditions

The service is **not** part of this repo and is not running by default. Before any request:

1. SneakerBot cloned somewhere outside `Nike-extension/`.
2. Node **18.16.0** (`.nvmrc`) — Puppeteer 13 fails on newer majors.
3. PostgreSQL reachable, with `.env.<NODE_ENV>` populated (`dotenv-flow`).
4. `npm install` → `npx knex migrate:latest` → `npx knex seed:run` → `npm start`.

Confirm it's up before doing anything else:

```bash
curl -sS http://localhost:8080/v1
```

Expect `Welcome to the SneakerBot API`. Connection refused means the service is down — say so
and stop; do not try to start it without being asked.

Base URL: `http://localhost:$PORT/v1` (`PORT` defaults to `8080`).
All bodies are JSON; send `Content-Type: application/json`. Responses wrap payloads as
`{ message, data }`.

## Sites

`site_id` is seeded and fixed:

| id | name |
|----|------|
| 1 | nike |
| 2 | footsites |
| 3 | shopify |
| 4 | demandware |
| 5 | supremenewyork |

## Endpoints

### Addresses — `/v1/addresses`

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/addresses` | create |
| GET | `/v1/addresses` | optional `?type=billing\|shipping` |
| GET | `/v1/addresses/:id` | |
| PATCH | `/v1/addresses/:id` | any create field, all optional |
| DELETE | `/v1/addresses/:id` | |

Create body — required: `type` (`billing`\|`shipping`), `first_name`, `last_name`,
`address_line_1`, `city`, `state`, `postal_code`, `country`, `email_address` (valid email),
`phone_number`. Optional: `address_line_2`.

### Proxies — `/v1/proxies`

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/proxies` | |
| GET | `/v1/proxies` | optional `?protocol=` |
| GET | `/v1/proxies/:id` | |
| PATCH | `/v1/proxies/:id` | |
| DELETE | `/v1/proxies/:id` | |

Create body — required: `ip_address`, `protocol`. Optional: `port`, `username`, `password`.
A task with no proxies registered runs on the host's own IP.

### Tasks — `/v1/tasks`

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/tasks` | create |
| GET | `/v1/tasks` | filters: `site_id`, `url`, `size`, `billing_address_id`, `shipping_address_id`, `notification_email_address` |
| GET | `/v1/tasks/:id` | |
| PATCH | `/v1/tasks/:id` | |
| DELETE | `/v1/tasks/:id` | |
| POST | `/v1/tasks/:id/start` | **launches a real checkout run** — see Boundaries |
| POST | `/v1/tasks/:id/stop` | |

Create body — required: `site_id` (int), `url` (string), `billing_address_id` (int),
`shipping_address_id` (int). Optional/nullable: `product_code`, `style_index` (int),
`size` (string), `shipping_speed_index` (int), `notification_email_address` (email).

`start` body — optional `card_friendly_name`, matching an entry in the service's
`credit-cards.js`. Omitted, it falls back to the single card in `.env`.

Addresses must exist before a task references them; create them first and reuse the returned ids.

## Recipes

Create an address, then a Nike task:

```bash
curl -sS -X POST http://localhost:8080/v1/addresses \
  -H 'Content-Type: application/json' \
  -d '{"type":"shipping","first_name":"A","last_name":"B","address_line_1":"1 Main St","city":"Singapore","state":"SG","postal_code":"018956","country":"SG","email_address":"a@b.com","phone_number":"+6580000000"}'
```

```bash
curl -sS -X POST http://localhost:8080/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"site_id":1,"url":"https://www.nike.com/t/example","size":"US 10","billing_address_id":1,"shipping_address_id":1}'
```

Inspect, then stop:

```bash
curl -sS http://localhost:8080/v1/tasks/1
```

```bash
curl -sS -X POST http://localhost:8080/v1/tasks/1/stop
```

## Boundaries

Setup, CRUD, inspection, and stopping tasks are all fine to do on request.

**Do not call `POST /v1/tasks/:id/start` on your own initiative.** It drives a live Puppeteer
checkout that spends the user's real money and routes CAPTCHAs through 2Captcha. Build the task,
show it to the user, and let them fire it — or get an explicit, specific go-ahead for that one
task first. Never treat "set up a task for X" as authorization to start it.

Related: never write card numbers, CVVs, email passwords, or the 2Captcha key into this repo or
any file here. They belong only in the service's own `.env`/`credit-cards.js`, outside this
project. If asked to put them here, say no and explain where they go.

## Troubleshooting

- **`ECONNREFUSED`** — service down, or `PORT` differs from 8080.
- **400 with a `details` array** — `express-validation` (Joi) rejected the body; the array names
  the offending field. Check required-vs-optional above.
- **500 `relation "..." does not exist`** — migrations never ran (`npx knex migrate:latest`).
- **Task starts then dies immediately** — usually Node version drift; Puppeteer 13 needs 18.16.0.
- **Checkout stalls on a challenge** — `API_KEY_2CAPTCHA` empty or out of balance. Report it and
  stop; do not attempt to solve the challenge another way.
