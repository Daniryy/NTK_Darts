-- Камеры турнира: трансляции VK (или YouTube, RuTube) и какие мишени снимает каждая.
-- [{ "title": "Камера 1", "url": "https://vk.com/video-123_456", "boards": [1, 2] }]
ALTER TABLE tournaments ADD COLUMN streams jsonb;
