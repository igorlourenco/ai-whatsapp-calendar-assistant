CREATE TABLE `expense_categories` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`emoji` text NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`budget` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`amount` integer NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`spent_on` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `expenses_spent_idx` ON `expenses` (`spent_on`);--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `expense_focus` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `expense_focus_at` integer;--> statement-breakpoint
ALTER TABLE `profile` ADD `expense_daily` integer;--> statement-breakpoint
ALTER TABLE `profile` ADD `expense_at` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `expense_budget` integer;--> statement-breakpoint
INSERT INTO `expense_categories` (`slug`, `name`, `emoji`, `description`, `is_default`, `created_at`) VALUES
	('alimentacao', 'Alimentação', '🍔', 'restaurante, delivery (iFood), lanche, café, bar pra comer', 0, strftime('%s','now') * 1000),
	('mercado', 'Mercado', '🛒', 'supermercado, feira, padaria, açougue, hortifruti', 0, strftime('%s','now') * 1000),
	('transporte', 'Transporte', '🚗', 'uber, 99, táxi, gasolina, estacionamento, pedágio, ônibus, metrô', 0, strftime('%s','now') * 1000),
	('moradia', 'Moradia', '🏠', 'aluguel, condomínio, IPTU, reforma, manutenção da casa', 0, strftime('%s','now') * 1000),
	('contas', 'Contas', '💡', 'luz, água, gás, internet, celular', 0, strftime('%s','now') * 1000),
	('saude', 'Saúde', '💊', 'farmácia, remédio, consulta, exame, plano de saúde, dentista', 0, strftime('%s','now') * 1000),
	('lazer', 'Lazer', '🎉', 'cinema, show, festa, bar com amigos, viagem, passeio, jogos', 0, strftime('%s','now') * 1000),
	('compras', 'Compras', '🛍️', 'roupa, eletrônico, coisas pra casa, presente', 0, strftime('%s','now') * 1000),
	('assinaturas', 'Assinaturas', '🔁', 'streaming, apps, academia, mensalidades recorrentes', 0, strftime('%s','now') * 1000),
	('educacao', 'Educação', '📚', 'faculdade, curso, livro, material de estudo', 0, strftime('%s','now') * 1000),
	('dates', 'Dates', '💘', 'TUDO que for gasto em date/encontro (jantar, cinema, bar, uber, flores, presente do date). Ganha das outras quando a mensagem fala em date', 0, strftime('%s','now') * 1000),
	('outros', 'Outros', '📦', 'o que não encaixa em nenhuma', 1, strftime('%s','now') * 1000);
