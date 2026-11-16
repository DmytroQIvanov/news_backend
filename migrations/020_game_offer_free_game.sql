ALTER TABLE game_offers DROP CONSTRAINT IF EXISTS game_offers_offer_type_check;
ALTER TABLE game_offers ADD CONSTRAINT game_offers_offer_type_check
  CHECK (offer_type IN ('giveaway', 'demo', 'beta', 'dlc', 'discount', 'free_game'));
