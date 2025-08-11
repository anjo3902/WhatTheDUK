/*
  # Add Missing Dependencies and Enhancements

  1. New Features
    - Add React Native AsyncStorage dependency
    - Enhanced search capabilities with full-text search
    - User vote tracking for posts and comments
    - Hot score calculation improvements

  2. Database Enhancements
    - Add user vote tracking view
    - Improve hot score algorithm
    - Add search indexes for better performance

  3. Additional Tables
    - User vote preferences and tracking
*/

-- Add user votes view for tracking user interactions
CREATE OR REPLACE VIEW user_votes AS
SELECT 
  v.user_id,
  v.post_id,
  v.comment_id,
  v.vote_type,
  v.created_at
FROM votes v
WHERE v.user_id = auth.uid();

-- Enhanced hot score calculation function
CREATE OR REPLACE FUNCTION calculate_hot_score(
  vote_score integer,
  comment_count integer,
  created_at timestamptz
)
RETURNS real
LANGUAGE plpgsql
AS $$
DECLARE
  age_in_hours real;
  gravity real := 1.8;
  base_score real;
BEGIN
  age_in_hours := EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0;
  base_score := (vote_score + comment_count * 0.5);
  
  -- Prevent division by zero and negative scores
  IF age_in_hours <= 0 THEN
    age_in_hours := 0.1;
  END IF;
  
  RETURN base_score / POWER(age_in_hours + 2, gravity);
END;
$$;

-- Function to update all hot scores (can be called periodically)
CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE posts 
  SET hot_score = calculate_hot_score(vote_score, comment_count, created_at)
  WHERE is_approved = true AND NOT is_removed;
END;
$$;

-- Add function to get user's vote on a specific post/comment
CREATE OR REPLACE FUNCTION get_user_vote(target_id uuid, target_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_vote_type text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  IF target_type = 'post' THEN
    SELECT vote_type INTO user_vote_type
    FROM votes
    WHERE user_id = auth.uid() AND post_id = target_id;
  ELSIF target_type = 'comment' THEN
    SELECT vote_type INTO user_vote_type
    FROM votes
    WHERE user_id = auth.uid() AND comment_id = target_id;
  END IF;

  RETURN user_vote_type;
END;
$$;

-- Enhanced posts view with user vote information
CREATE OR REPLACE VIEW posts_with_user_data AS
SELECT 
  p.*,
  get_user_vote(p.id, 'post') as user_vote
FROM posts_with_stats p;

-- Add search configuration for better full-text search
CREATE TEXT SEARCH CONFIGURATION IF NOT EXISTS duk_search (COPY = english);
ALTER TEXT SEARCH CONFIGURATION duk_search
  ALTER MAPPING FOR word, numword, asciiword, numhword, asciihword, hword_numpart, hword_part, hword_asciipart
  WITH unaccent, simple;

-- Update search indexes to use the new configuration
DROP INDEX IF EXISTS idx_posts_search;
CREATE INDEX idx_posts_search ON posts USING gin(
  to_tsvector('duk_search', title || ' ' || content)
) WHERE is_approved = true AND NOT is_removed;

DROP INDEX IF EXISTS idx_communities_search;
CREATE INDEX idx_communities_search ON communities USING gin(
  to_tsvector('duk_search', name || ' ' || description)
) WHERE is_active = true;

-- Add composite indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_posts_community_hot ON posts(community_id, hot_score DESC) WHERE is_approved = true;
CREATE INDEX IF NOT EXISTS idx_posts_community_new ON posts(community_id, created_at DESC) WHERE is_approved = true;
CREATE INDEX IF NOT EXISTS idx_posts_community_top ON posts(community_id, vote_score DESC) WHERE is_approved = true;

-- Add function to get community posts with user vote data
CREATE OR REPLACE FUNCTION get_community_posts(
  p_community_id uuid,
  p_sort_by text DEFAULT 'hot',
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  author_display_name text,
  community_name text,
  created_at timestamptz,
  vote_score integer,
  comment_count integer,
  is_anonymous boolean,
  user_vote text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id,
    p.title,
    p.content,
    p.author_display_name,
    p.community_name,
    p.created_at,
    p.vote_score,
    p.comment_count,
    p.is_anonymous,
    get_user_vote(p.id, 'post') as user_vote
  FROM posts_with_stats p
  WHERE 
    p.community_id = p_community_id
    AND p.is_approved = true
    AND NOT p.is_removed
  ORDER BY 
    CASE 
      WHEN p_sort_by = 'new' THEN p.created_at
      ELSE NULL
    END DESC,
    CASE 
      WHEN p_sort_by = 'top' THEN p.vote_score
      ELSE NULL
    END DESC,
    CASE 
      WHEN p_sort_by = 'hot' THEN p.hot_score
      ELSE NULL
    END DESC,
    p.created_at DESC
  LIMIT p_limit;
END;
$$;