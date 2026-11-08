-- Problem reports reach the admins as a topic of their own; a channel that
-- carries alerts carries them too, until someone unticks it.
UPDATE channels SET topics = json_insert(topics, '$[#]', 'problems') WHERE topics LIKE '%"alerts"%' AND topics NOT LIKE '%"problems"%';
