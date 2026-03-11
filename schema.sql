-- ============================================================
-- SCHEMA — Transcrição Universal
-- Execute este arquivo no SQL Editor do seu projeto Supabase:
--   Painel Supabase → SQL Editor → New Query → Cole e rode
-- ============================================================

-- Tabela de usuários (cadastro próprio + Google OAuth)
CREATE TABLE IF NOT EXISTS public.users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  email                 text UNIQUE NOT NULL,
  password_hash         text,           -- 'google:<sub>' para contas Google
  is_premium            boolean NOT NULL DEFAULT false,
  email_verified        boolean NOT NULL DEFAULT false,
  mp_subscription_id    text,
  next_billing_date     timestamptz,
  subscription_cancelled boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Tabela de uso diário de transcrições
CREATE TABLE IF NOT EXISTS public.usage (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date      date NOT NULL,
  count     integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS users_email_idx ON public.users (email);
CREATE INDEX IF NOT EXISTS usage_user_date_idx ON public.usage (user_id, date);

-- Row Level Security (RLS) — o servidor usa a service role key,
-- então as políticas abaixo só protegem acesso direto pelo cliente anon.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage  ENABLE ROW LEVEL SECURITY;

-- Sem políticas adicionais: o backend (service role) tem acesso total.
-- Acesso pelo anon key é bloqueado por padrão (sem política = negar).
