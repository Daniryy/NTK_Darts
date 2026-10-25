-- Вид сетки, выбирается при создании турнира.
-- layout: 'ndl' — порядок матчей как на бумажном листе NDL (1–8, 5–4, 3–6, 7–2), 'std' — классический (1–8, 4–5, 2–7, 3–6).
-- labels: 'ab' — подписи как на листе (A1–A2, B1–B2), 'num' — номера матчей №1, №2…
-- У старых турниров null: классический порядок и номера.
ALTER TABLE tournaments
  ADD COLUMN layout text CHECK (layout IN ('ndl', 'std')),
  ADD COLUMN labels text CHECK (labels IN ('ab', 'num'));
