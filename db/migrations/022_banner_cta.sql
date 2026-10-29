-- баннер: текст кнопки («Подключить →»); ссылка может вести и на страницу сайта (#plans, #tours…)
ALTER TABLE banners ADD COLUMN cta text;
