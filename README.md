# Transcrição Universal

> Transcreva vídeos do YouTube, TikTok, Instagram e Twitter/X em segundos — direto no navegador, sem instalar nada.

[![Deploy](https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=white)](https://transcricao-universal.onrender.com)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)](#licen%C3%A7a)

---

## ✨ Funcionalidades

| Funcionalidade | Gratuito | Premium |
|---|:---:|:---:|
| Transcrição de vídeos (YouTube, TikTok, Instagram, Twitter/X) | ✅ | ✅ |
| Limite de uso diário | 3/dia | Ilimitado |
| Sem anúncios | ❌ | ✅ |
| Suporte prioritário | ❌ | ✅ |

- **Autenticação completa** — cadastro, login, recuperação de senha por e-mail
- **Login social** — Google OAuth via Supabase
- **Pagamento PIX** — integração com MercadoPago, ativação automática do Premium
- **Excluir conta** — exclusão permanente com confirmação de senha
- **Interface responsiva** — funciona em celular e desktop

---

## 🛠 Tecnologias

- **Backend:** Node.js + Express
- **Banco de dados:** Supabase (PostgreSQL)
- **Autenticação:** JWT + bcryptjs
- **Transcrição:** Groq Whisper API + yt-dlp
- **Pagamentos:** MercadoPago (PIX)
- **E-mail:** Nodemailer (Gmail SMTP)
- **Frontend:** HTML + CSS + JavaScript puro (sem frameworks)
- **Hospedagem:** Render (free tier)

---

## 🚀 Como rodar localmente

### Pré-requisitos

- [Node.js 18+](https://nodejs.org)
- Conta no [Supabase](https://supabase.com)
- API Key do [Groq](https://console.groq.com)
- Conta no [MercadoPago](https://www.mercadopago.com.br) (para pagamentos)

### Instalação

```bash
# Clone o repositório
git clone https://github.com/ericdalaporta/transcricao-universal.git
cd transcricao-universal

# Instale as dependências
npm install
```

### Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua_chave_anon
SUPABASE_SERVICE_ROLE_KEY=sua_chave_service_role

JWT_SECRET=uma_chave_secreta_qualquer

MP_ACCESS_TOKEN=seu_token_mercadopago

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=seu_email@gmail.com
SMTP_PASS=sua_senha_de_app

GROQ_API_KEY=sua_chave_groq
```

### Banco de dados

Execute o script `schema.sql` no Editor SQL do Supabase para criar as tabelas necessárias.

### Iniciar

```bash
node server.js
```

Acesse em: [http://localhost:3000](http://localhost:3000)

---

## 📁 Estrutura do projeto

```
├── server.js        # API back-end (Express)
├── index.html       # Página principal do app
├── login.html       # Tela de login / cadastro
├── schema.sql       # Estrutura do banco de dados
├── package.json     # Dependências Node.js
└── .env             # Variáveis de ambiente (não commitado)
```

---

## 🌐 Deploy na Render

1. Faça fork/clone deste repositório no GitHub
2. Crie um **Web Service** na [Render](https://render.com) apontando para o repositório
3. Defina as variáveis de ambiente (mesmas do `.env`) no painel da Render
4. O deploy acontece automaticamente a cada `git push`

---

## 📄 Licença

MIT © [Eric Dalaporta](https://github.com/ericdalaporta)
