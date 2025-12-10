# 🌍 EuskoTrips — Plataforma de Turismo Inteligente

EuskoTrips es una plataforma modular que integra un **orquestador de servicios**, un motor de recomendaciones basado en similitud, un **gateway API en Node.js**, un **servicio de recomendación en FastAPI**, un **pipeline de ingestión de datos**, y un pequeño **frontend** para pruebas.
El proyecto utiliza contenedores Docker para facilitar la puesta en marcha y la replicación del entorno.

---

## 📦 0) Software necesario

Antes de ejecutar el proyecto, asegúrate de tener instalado:

* **Docker**
* **Docker Compose**
* **Git**
* (Opcional) **Python 3.10+** si quieres ejecutar scripts del *data pipeline* fuera de Docker
* (Opcional) **Node.js 18+** si quieres ejecutar el gateway localmente sin contenedor

---

## 🧩 1) Servicios incluidos en la arquitectura

La arquitectura completa se define en `docker-compose.yml` e incluye:

| Servicio            | Tecnología        | Rol                                                                                            |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| **PostgreSQL**      | Docker oficial    | Base de datos principal (usuarios, favoritos, dataset turístico procesado)                     |
| **Elasticsearch**   | Docker oficial    | Índices para búsquedas, item similarity y almacenamiento de POIs                               |
| **Recommender API** | FastAPI (Python)  | Servicio que expone endpoints de recomendación                                                 |
| **Gateway API**     | Node.js + Express | Puerta de entrada del frontend, maneja autenticación, favoritos y comunicación con Recommender |
| **Frontend**        | HTML estático     | Página para pruebas de la API y flujo básico                                                   |
| **Data Pipeline**   | Python            | Ingestión automática de datos de turismo en Elasticsearch                                      |

---

## 🔹 Automatización del Data Pipeline

El servicio **`data_pipeline`** ejecuta automáticamente el script:

```
fetch_opendata_turismo.py
```

Este script:

* Descarga y procesa los datos turísticos.
* Los indexa en Elasticsearch.
* Se ejecuta **solo cuando Elasticsearch está listo**, gracias a `depends_on` + healthcheck.
* Corre **una única vez** en cada `docker compose up`.

De esta forma, al levantar el entorno, Elasticsearch ya dispone de datos indexados sin tener que ejecutar nada manualmente.

---

## 📥 2) Dependencias del proyecto

Cada servicio contiene sus propias dependencias:

### 🔹 Backend / Gateway (Node)

En `backend/gateway/package.json`:

```bash
npm install
```

Dependencias principales:

* express
* cors
* morgan
* node-fetch
* pg
* bcryptjs
* jsonwebtoken

---

### 🔹 Backend / Recommender (Python – FastAPI)

En `backend/recommender/requirements.txt`:

```bash
pip install -r requirements.txt
```

Dependencias principales:

* fastapi
* uvicorn
* python-dotenv
* pg8000
* httpx

---

### 🔹 Data Pipeline (scraping / ingestión)

En `backend/data_pipeline/requirements.txt`:

```bash
pip install -r requirements.txt
```

Dependencias principales:

* requests
* beautifulsoup4
* lxml

---

## 🚀 3) Cómo arrancar la parte servidora

La forma recomendada es con Docker Compose.

Desde la raíz del proyecto:

```bash
docker compose up --build
```

Esto levantará automáticamente:

1. PostgreSQL
2. Elasticsearch
3. Data Pipeline → indexa datos en ES
4. Recommender
5. Gateway

Cuando todo esté levantado, podrás ver mensajes tipo:

```
et_gateway       | Gateway escuchando en http://localhost:3000
et_recommender   | Uvicorn running on http://0.0.0.0:8000
et_data_pipeline | ✅ Ingesta de OpenData Euskadi completada.
```

### 📌 Variables de entorno

Asegúrate de que el fichero `.env` contiene valores como:

```env
POSTGRES_DB=euskotrips
POSTGRES_USER=eusko
POSTGRES_PASSWORD=eusko_pwd

JWT_SECRET=super-secret-euskotrips-1234567890-no-compartir

GITHUB_CLIENT_ID=xxxxx
GITHUB_CLIENT_SECRET=xxxxx
GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback

FRONTEND_ORIGIN=http://localhost:3000
```

---

## 🎨 4) Cómo acceder a la parte cliente

El frontend estático se sirve desde el propio gateway, accesible en:

👉 **[http://localhost:3000](http://localhost:3000)**

Desde ahí podrás interactuar con:

* Login / registro (si está implementado)
* Chat / pruebas del orquestador
* Recomendaciones
* Carga de datos básicos

### Endpoints útiles

| Servicio        | URL                                                      |
| --------------- | -------------------------------------------------------- |
| Gateway API     | [http://localhost:3000](http://localhost:3000)           |
| Recommender API | [http://localhost:8000/docs](http://localhost:8000/docs) |
| Elasticsearch   | [http://localhost:9200](http://localhost:9200)           |
| PostgreSQL      | localhost:5432                                           |

---

## 📚 Estructura del proyecto

```text
euskotrips/
|--- backend/
|     |--- data_pipeline/
|     |--- db/
|     |--- gateway/
|     |--- recommender/
|
|--- frontend/
|     |--- index.html
|
|--- docker-compose.yml
|--- .env
|--- README.md
```

---

## 🛠️ Scripts útiles

### Ejecutar el pipeline manualmente

```bash
cd backend/data_pipeline
python fetch_opendata_turismo.py
```

### Reiniciar contenedores desde cero

```bash
docker compose down -v
docker compose up --build
```

---

## 📝 Notas adicionales

* Los datos descargados de OpenDataEuskadi se indexan automáticamente gracias al servicio `data_pipeline`.
* El gateway actúa como único punto de acceso del cliente.
* El recommender es independiente y puede evolucionar con modelos reales más adelante.

---