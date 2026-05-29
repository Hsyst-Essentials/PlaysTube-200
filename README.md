# PlaysTube v3.0.0

Plataforma de compartilhamento de vídeos com suporte a lives, similar ao YouTube, construída com **Node.js**, **Express**, **SQLite**, **Socket.IO**, **FFmpeg** e **Node-Media-Server**.

---

## Visão geral

PlaysTube é uma plataforma completa de vídeo que suporta:

- **VOD** — Upload, transcodificação para HLS em múltiplas resoluções (360p–1080p), player adaptativo
- **Lives** — Transmissão ao vivo via RTMP com chat em tempo real (Socket.IO), FLV.js no player
- **Agendamento** — Lives podem ser criadas agora ou agendadas para uma data/hora específica
- **Recomendações** — Baseadas em tags com fuzzy matching e stemming (Jaro-Winkler + Levenshtein)
- **Inscrições** — Sistema de canais com notificações
- **Pronomes** — Suporte a pronomes (ele/dele, ela/dela, não especificado) nas mensagens da plataforma

---

## Pré-requisitos

- **Node.js** >= 18
- **FFmpeg** instalado e acessível (ou configure o caminho manualmente)
- NPM

---

## Configuração

### 1. Clone e instale

```bash
git clone https://github.com/op3ny/playstube.git
cd playstube
npm install
```

### 2. Configure o FFmpeg

Edite `index.js` e ajuste o caminho do FFmpeg no `nmsConfig.trans.ffmpeg`:

```js
// Windows:
ffmpeg: 'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe'

// Linux:
ffmpeg: '/usr/bin/ffmpeg'

// macOS (Homebrew):
ffmpeg: '/opt/homebrew/bin/ffmpeg'
```

### 3. Configure a chave JWT

Edite `index.js` e substitua `JWT_SECRET` por uma chave segura:

```js
const JWT_SECRET = "sua-chave-super-segura-aqui";
```

### 4. Configure a URL da API (para produção)

As views EJS usam `http://localhost:4000/api` hardcoded. Para produção, altere em todos os arquivos `.ejs` dentro de `views/`.

---

## Como rodar

```bash
npm start
```

O servidor iniciará em `http://localhost:4000`.

| Serviço              | Porta |
|----------------------|-------|
| Servidor web (HTTP)  | 4000  |
| RTMP (streaming)     | 1935  |
| FLV (reprodução)     | 8000  |

---

## Fluxos de uso

### Criar conta e canal

1. Acesse `/auth` e crie uma conta (nome, email, senha)
2. Acesse `/creator` (Creator Studio) e crie um canal
3. Configure pronomes, avatar e banner nas configurações do canal

### Enviar vídeo

1. No Creator Studio, clique em "Enviar Vídeo"
2. Selecione o arquivo, defina título, descrição e tags
3. O servidor faz upload, gera thumbnail (primeiro frame) e transcodifica para HLS:
   - **Imediato:** 360p
   - **Fila de fundo:** 480p, 720p, 1080p (processamento assíncrono)
4. Os vídeos aparecem na home page e na página do canal

### Fazer live agora

1. No Creator Studio > aba "Live", preencha título e clique em "Começar Agora"
2. A live entra em status `waiting` — a página da live mostra "A Live está iniciando em breve!"
3. Configure seu software de streaming (OBS, StreamYard):
   - **Servidor RTMP:** `rtmp://localhost/live`
   - **Stream Key:** a chave exibida no painel
4. Comece a transmissão no OBS — o servidor detecta e muda o status para `live`
5. Espectadores assistem em `/live/:channelId` com chat em tempo real

### Agendar live

1. No Creator Studio > aba "Live", preencha título e escolha data/hora em "Agendar"
2. A live entra em status `scheduled` — aparece na home page com badge "EM BREVE"
3. Na página da live, espectadores veem um contador regressivo
4. Conecte o OBS antes do horário — o servidor muda para `ready`
5. Quando o horário chegar, o servidor automaticamente muda para `live`
6. Se passar do horário sem transmissão, muda para `delayed`; após 10min, `cancelled`

### Encerrar live

1. No Creator Studio, clique em "Encerrar Transmissão"
2. A live muda para `ended` — espectadores veem "Transmissão Encerrada"
3. Crie uma nova live normalmente para começar outra

### Interagir

- **Like/Dislike:** na página do vídeo
- **Comentários:** autenticado, na página do vídeo
- **Inscrição:** na página do canal (com notificações)
- **Chat ao vivo:** na página da live (via Socket.IO)

---

## Status das lives

| Status        | Descrição                                       |
|---------------|-------------------------------------------------|
| `scheduled`   | Agendada para uma data/hora futura              |
| `ready`       | Streamer conectou antes do horário agendado     |
| `waiting`     | Criada agora, aguardando streamer conectar      |
| `live`        | Transmissão ativa                               |
| `delayed`     | Passou do horário agendado, streamer não conectou |
| `ended`       | Transmissão encerrada                           |
| `cancelled`   | Cancelada (por atraso >10min ou pelo streamer)  |

---

## Rotas da aplicação

### Páginas (server-rendered com EJS)

| Rota               | Descrição                       |
|--------------------|---------------------------------|
| `/`                | Home com grid de vídeos e lives |
| `/?q=termo`        | Busca por título, descrição, tags |
| `/auth`            | Login / Cadastro                |
| `/video/:id`       | Player de vídeo + comentários   |
| `/channel/:id`     | Página do canal                 |
| `/user/:id`        | Perfil do usuário               |
| `/live`            | Lista de transmissões ao vivo   |
| `/live/:channelId` | Player da live + chat           |
| `/creator`         | Creator Studio (dashboard)      |

### API REST

#### Autenticação

| Método | Rota             | Descrição                  |
|--------|------------------|----------------------------|
| POST   | `/api/register`  | Criar conta                |
| POST   | `/api/login`     | Login                      |
| POST   | `/api/logout`    | Logout                     |

#### Usuário

| Método | Rota                  | Descrição                |
|--------|------------------------|--------------------------|
| GET    | `/api/users/me`        | Dados do usuário logado  |
| PATCH  | `/api/users/me`        | Atualizar perfil         |
| POST   | `/api/users/me/avatar` | Upload de avatar         |
| GET    | `/api/users/:id`       | Dados públicos do usuário|

#### Canais

| Método | Rota                                  | Descrição                   |
|--------|----------------------------------------|-----------------------------|
| GET    | `/api/channels`                        | Listar canais do usuário    |
| POST   | `/api/channels`                        | Criar canal                 |
| GET    | `/api/channels/:id`                    | Dados do canal              |
| PATCH  | `/api/channels/:id`                    | Atualizar canal             |
| DELETE | `/api/channels/:id`                    | Excluir canal               |
| GET    | `/api/channels/:id/videos`             | Vídeos do canal             |
| POST   | `/api/channels/:id/subscribe`          | Inscrever-se                |
| DELETE | `/api/channels/:id/subscribe`          | Cancelar inscrição          |
| GET    | `/api/channels/:id/subscribed`         | Verificar inscrição         |
| GET    | `/api/channels/:id/subscribers/count`  | Contagem de inscritos       |
| GET    | `/api/channels/:id/stream-key`         | Obter stream key            |
| POST   | `/api/channels/:id/stream-key`         | Regenerar stream key        |
| POST   | `/api/channels/:id/avatar`             | Upload avatar do canal      |
| POST   | `/api/channels/:id/banner`             | Upload banner do canal      |
| POST   | `/api/channels/:id/schedule-live`      | Agendar live                |

#### Vídeos

| Método | Rota                          | Descrição                    |
|--------|--------------------------------|------------------------------|
| GET    | `/api/videos`                  | Listar vídeos (query `?q=`)  |
| POST   | `/api/videos`                  | Upload de vídeo (multipart)  |
| GET    | `/api/videos/:id`              | Detalhes + resoluções + tags |
| PATCH  | `/api/videos/:id`              | Editar título/descrição      |
| DELETE | `/api/videos/:id`              | Excluir vídeo                |
| GET    | `/api/videos/:id/render-status`| Status do processamento      |
| POST   | `/api/videos/:id/render`       | Forçar render de resolução   |
| POST   | `/api/videos/:id/like`         | Like/dislike (body: `type`)  |
| DELETE | `/api/videos/:id/like`         | Remover like/dislike         |
| GET    | `/api/videos/:id/comments`     | Listar comentários           |
| POST   | `/api/videos/:id/comments`     | Criar comentário             |

#### Lives

| Método | Rota                       | Descrição                   |
|--------|-----------------------------|-----------------------------|
| GET    | `/api/live`                 | Listar lives ativas         |
| POST   | `/api/live`                 | Criar live (agora ou agendar) |
| GET    | `/api/live/:id`             | Detalhes da live            |
| DELETE | `/api/live/:id`             | Encerrar live               |
| POST   | `/api/live/:id/cancel`      | Cancelar live               |
| GET    | `/api/live/:id/viewers`     | Contagem de espectadores    |
| GET    | `/api/live/:channelId/status` | Status com delay info     |
| POST   | `/api/live/:channelId/chat` | Enviar mensagem no chat     |
| GET    | `/api/channels/:id/live`    | Live ativa do canal         |

#### Webhooks (RTMP)

| Método | Rota                      | Descrição                        |
|--------|---------------------------|----------------------------------|
| POST   | `/api/webhook/live-start` | Notificar início de transmissão  |
| POST   | `/api/webhook/live-end`   | Notificar fim de transmissão     |

#### Recomendações

| Método | Rota                   | Descrição                          |
|--------|-------------------------|------------------------------------|
| GET    | `/api/recommendations`  | Vídeos recomendados (baseado em tags) |

#### Criador

| Método | Rota                  | Descrição                   |
|--------|------------------------|-----------------------------|
| GET    | `/api/creator/videos`  | Vídeos com status de render |
| GET    | `/api/creator/stats`   | Estatísticas do criador     |

#### Notificações

| Método | Rota                               | Descrição                |
|--------|-------------------------------------|--------------------------|
| GET    | `/api/notifications`                | Listar notificações      |
| POST   | `/api/notifications/:id/read`       | Marcar como lida         |
| POST   | `/api/notifications/read-all`       | Marcar todas como lidas  |
| GET    | `/api/notifications/unread-count`   | Contagem de não lidas    |

#### RTMP

| Método | Rota               | Descrição              |
|--------|---------------------|------------------------|
| GET    | `/api/rtmp/sessions`| Sessões RTMP ativas    |

---

## Estrutura do banco de dados (SQLite)

| Tabela                   | Descrição                            |
|--------------------------|--------------------------------------|
| `users`                  | Usuários (id, name, email, password_hash, bio, pronouns, avatar_url) |
| `channels`               | Canais (id, owner_id, name, description, pronouns, stream_key, banner_url, avatar_url) |
| `videos`                 | Vídeos (id, channel_id, title, description, views, created_at) |
| `video_resolutions`      | Resoluções processadas (label: 360p, 480p, 720p, 1080p) |
| `video_tags`             | Relação vídeo-tag                    |
| `tags`                   | Tags normalizadas                    |
| `tag_synonyms`           | Sinônimos de tags (fuzzy matching)   |
| `view_history`           | Histórico de visualizações           |
| `video_likes`            | Likes/dislikes                       |
| `comments`               | Comentários                          |
| `channel_subscriptions`  | Inscrições em canais                 |
| `notifications`          | Notificações                         |
| `render_queue`           | Fila de transcodificação             |
| `live_streams`           | Transmissões ao vivo (com viewer_count, scheduled_at) |
| `live_chat_messages`     | Mensagens do chat ao vivo            |

---

## Tecnologias

- **Backend:** Express, Socket.IO, Node-Media-Server
- **Banco:** SQLite3
- **Templates:** EJS + Tailwind CSS (CDN)
- **Player:** HLS.js (VOD), flv.js (lives)
- **Processamento:** FFmpeg (transcodificação HLS)
- **Auth:** JWT + bcrypt + cookies
- **Streaming:** RTMP (push), FLV over HTTP/WS (playback)

---

## Licença

Distribuído sob a **Unlicense** — domínio público. Sinta-se livre para usar, modificar e distribuir.

---

## Autora

**Thaís** — [@op3ny](https://github.com/op3ny)

Feito com carinho para a comunidade <3
