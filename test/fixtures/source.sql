CREATE TYPE public.task_state AS ENUM ('open', 'done');

CREATE TABLE public.teams (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id integer NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  title text NOT NULL,
  details jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  state public.task_state NOT NULL DEFAULT 'open'::public.task_state,
  attachment bytea
);

CREATE INDEX tasks_team_id_idx ON public.tasks(team_id);

INSERT INTO public.teams (name) OVERRIDING SYSTEM VALUE VALUES
  ('Alpha'),
  ('日本語チーム');

INSERT INTO public.tasks (team_id, title, details, active, state, attachment) VALUES
  (1, E'Line one\nLine two', '{"priority":1,"labels":["a","b"]}', true, 'open', decode('00ff10', 'hex')),
  (2, E'Tab\tand quote '' test', '{"priority":2}', false, 'done', NULL);
