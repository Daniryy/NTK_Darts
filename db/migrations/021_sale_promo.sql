-- Скидка на открытие (общая, на срок) и промокоды.
-- settings.sale — { pct, until, title }: цены со скидкой округляются красиво (−50%: 249 → 119, 2490 → 1190, 799 → 399, 7990 → 3990)
INSERT INTO settings (key, value, updated_at) VALUES ('sale', '{"pct": 50, "until": null, "title": "Скидка на открытие"}', 0) ON CONFLICT (key) DO NOTHING;

-- промокод: процент сверху цены, срок, лимит использований, на какие тарифы (null — на все)
CREATE TABLE promo_codes (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  pct         integer NOT NULL CHECK (pct BETWEEN 1 AND 90),
  until       bigint,
  max_uses    integer CHECK (max_uses > 0),
  used        integer NOT NULL DEFAULT 0,
  plans       text[],
  active      boolean NOT NULL DEFAULT true,
  note        text NOT NULL DEFAULT '',
  created_by  text REFERENCES players(id) ON DELETE SET NULL,
  created_at  bigint NOT NULL
);
-- заявка и подключение помнят промокод; цена заявки — та, что игрок видел
ALTER TABLE player_plans ADD COLUMN promo_id integer REFERENCES promo_codes(id) ON DELETE SET NULL;
