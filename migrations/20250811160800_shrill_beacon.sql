/*
  # Views and Helper Functions

  1. Views
    - `posts_with_stats` - Posts with calculated statistics and author info
    - `communities_with_membership` - Communities with user membership status
    - `user_stats` - User activity statistics
    - `moderation_queue` - Content pending moderation

  2. Functions
    - Vote calculation and hot score algorithms
    - Content moderation helpers
    - Search functionality
*/

-- View for posts with all calculated stats and author info
CREATE OR REPLACE VIEW posts_with_stats AS
SELECT 
  p.id,
  p.title,
  p.content,
  p.author_id,
  p.community_id,
  c.name as community_name,
  CASE 
    WHEN p.is_anonymous THEN 
      COALESCE(aa.alias_name, 'Anon-' || substring(md5(p.author_id::text || p.community_id::text) from 1 for 6))
    ELSE 
      prof.display_name
  END as author_display_name,
  p.is_anonymous,
  p.is_approved,
  p.is_removed,
  p.moderation_status,
  p.toxicity_score,
  p.vote_score,
  p.comment_count,
  p.hot_score,
  p.created_at,
  p.updated_at
FROM posts p
JOIN communities c ON p.community_id = c.id
JOIN profiles prof ON p.author_id = prof.id
LEFT JOIN anon_aliases aa ON p.author_id = aa.user_id AND p.community_id = aa.community_id AND p.is_anonymous = true
WHERE NOT p.is_removed;

-- View for communities with user membership status
CREATE OR REPLACE VIEW communities_with_membership AS
SELECT 
  c.id,
  c.name,
  c.description,
  c.privacy_type,
  c.owner_id,
  c.member_count,
  c.post_count,
  c.is_active,
  c.created_at,
  CASE 
    WHEN m.user_id IS NOT NULL THEN true 
    ELSE false 
  END as is_member,
  COALESCE(m.status, 'none') as membership_status,
  m.role as user_role
FROM communities c
LEFT JOIN memberships m ON c.id = m.community_id AND m.user_id = auth.uid()
WHERE c.is_active = true;

-- View for user statistics
CREATE OR REPLACE VIEW user_stats AS
SELECT 
  p.id as user_id,
  COALESCE(post_stats.post_count, 0) as post_count,
  COALESCE(comment_stats.comment_count, 0) as comment_count,
  p.karma_score,
  COALESCE(membership_stats.communities_joined, 0) as communities_joined
FROM profiles p
LEFT JOIN (
  SELECT author_id, COUNT(*) as post_count
  FROM posts 
  WHERE is_approved = true AND NOT is_removed
  GROUP BY author_id
) post_stats ON p.id = post_stats.author_id
LEFT JOIN (
  SELECT author_id, COUNT(*) as comment_count
  FROM comments 
  WHERE is_approved = true AND NOT is_removed
  GROUP BY author_id
) comment_stats ON p.id = comment_stats.author_id
LEFT JOIN (
  SELECT user_id, COUNT(*) as communities_joined
  FROM memberships 
  WHERE status = 'approved'
  GROUP BY user_id
) membership_stats ON p.id = membership_stats.user_id;

-- View for moderation queue
CREATE OR REPLACE VIEW moderation_queue AS
SELECT 
  'post' as content_type,
  p.id,
  p.title as content_title,
  p.content,
  p.author_id,
  prof.display_name as author_name,
  prof.email as author_email,
  p.community_id,
  c.name as community_name,
  p.toxicity_score,
  p.moderation_status,
  p.created_at
FROM posts p
JOIN profiles prof ON p.author_id = prof.id
JOIN communities c ON p.community_id = c.id
WHERE p.moderation_status IN ('pending', 'flagged')

UNION ALL

SELECT 
  'comment' as content_type,
  cm.id,
  p.title as content_title,
  cm.content,
  cm.author_id,
  prof.display_name as author_name,
  prof.email as author_email,
  p.community_id,
  c.name as community_name,
  cm.toxicity_score,
  cm.moderation_status,
  cm.created_at
FROM comments cm
JOIN posts p ON cm.post_id = p.id
JOIN profiles prof ON cm.author_id = prof.id
JOIN communities c ON p.community_id = c.id
WHERE cm.moderation_status IN ('pending', 'flagged')

ORDER BY created_at ASC;

-- Function to calculate vote scores
CREATE OR REPLACE FUNCTION calculate_vote_score(target_id uuid, target_type text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  up_votes integer := 0;
  down_votes integer := 0;
BEGIN
  IF target_type = 'post' THEN
    SELECT 
      COUNT(CASE WHEN vote_type = 'up' THEN 1 END),
      COUNT(CASE WHEN vote_type = 'down' THEN 1 END)
    INTO up_votes, down_votes
    FROM votes 
    WHERE post_id = target_id;
  ELSIF target_type = 'comment' THEN
    SELECT 
      COUNT(CASE WHEN vote_type = 'up' THEN 1 END),
      COUNT(CASE WHEN vote_type = 'down' THEN 1 END)
    INTO up_votes, down_votes
    FROM votes 
    WHERE comment_id = target_id;
  END IF;
  
  RETURN up_votes - down_votes;
END;
$$;

-- Function to update vote scores when votes change
CREATE OR REPLACE FUNCTION update_vote_scores()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.post_id IS NOT NULL THEN
      UPDATE posts 
      SET vote_score = calculate_vote_score(NEW.post_id, 'post')
      WHERE id = NEW.post_id;
    ELSIF NEW.comment_id IS NOT NULL THEN
      UPDATE comments 
      SET vote_score = calculate_vote_score(NEW.comment_id, 'comment')
      WHERE id = NEW.comment_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.post_id IS NOT NULL THEN
      UPDATE posts 
      SET vote_score = calculate_vote_score(NEW.post_id, 'post')
      WHERE id = NEW.post_id;
    ELSIF NEW.comment_id IS NOT NULL THEN
      UPDATE comments 
      SET vote_score = calculate_vote_score(NEW.comment_id, 'comment')
      WHERE id = NEW.comment_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.post_id IS NOT NULL THEN
      UPDATE posts 
      SET vote_score = calculate_vote_score(OLD.post_id, 'post')
      WHERE id = OLD.post_id;
    ELSIF OLD.comment_id IS NOT NULL THEN
      UPDATE comments 
      SET vote_score = calculate_vote_score(OLD.comment_id, 'comment')
      WHERE id = OLD.comment_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

-- Create trigger for vote score updates
CREATE TRIGGER update_vote_scores_trigger
  AFTER INSERT OR UPDATE OR DELETE ON votes
  FOR EACH ROW
  EXECUTE FUNCTION update_vote_scores();

-- Function to search posts and communities
CREATE OR REPLACE FUNCTION search_content(search_query text)
RETURNS TABLE (
  result_type text,
  id uuid,
  title text,
  content text,
  community_name text,
  created_at timestamptz,
  rank real
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    'post'::text as result_type,
    p.id,
    p.title,
    p.content,
    c.name as community_name,
    p.created_at,
    ts_rank(to_tsvector('english', p.title || ' ' || p.content), plainto_tsquery('english', search_query)) as rank
  FROM posts p
  JOIN communities c ON p.community_id = c.id
  WHERE 
    p.is_approved = true 
    AND NOT p.is_removed
    AND to_tsvector('english', p.title || ' ' || p.content) @@ plainto_tsquery('english', search_query)
  
  UNION ALL
  
  SELECT 
    'community'::text as result_type,
    c.id,
    c.name as title,
    c.description as content,
    c.name as community_name,
    c.created_at,
    ts_rank(to_tsvector('english', c.name || ' ' || c.description), plainto_tsquery('english', search_query)) as rank
  FROM communities c
  WHERE 
    c.is_active = true
    AND to_tsvector('english', c.name || ' ' || c.description) @@ plainto_tsquery('english', search_query)
  
  ORDER BY rank DESC, created_at DESC;
END;
$$;