/*
  # Initial Schema for WhatTheDUK Platform

  1. New Tables
    - `profiles` - Extended user profiles with DUK-specific data
    - `communities` - Discussion communities with privacy settings
    - `memberships` - User-community relationships with approval status
    - `posts` - User posts with moderation and anonymity support
    - `comments` - Nested comments system
    - `votes` - Voting system for posts and comments
    - `anon_aliases` - Anonymous pseudonym management
    - `moderation_logs` - Complete audit trail for moderation actions
    - `trending_topics` - Track trending keywords

  2. Security
    - Enable RLS on all tables
    - Policies for user data access and community-based content
    - Domain restriction for registration (@duk.ac.in only)

  3. Features
    - Full-text search capabilities
    - Anonymous posting system with persistent pseudonyms
    - Comprehensive moderation pipeline
    - Community privacy settings and approval workflows
*/

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Profiles table for extended user data
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  bio text DEFAULT '',
  avatar_url text,
  is_verified boolean DEFAULT false,
  is_moderator boolean DEFAULT false,
  is_admin boolean DEFAULT false,
  karma_score integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT valid_email_domain CHECK (email ~* '^[^@]+@duk\.ac\.in$')
);

-- Communities table
CREATE TABLE IF NOT EXISTS communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  description text NOT NULL,
  privacy_type text NOT NULL DEFAULT 'public' CHECK (privacy_type IN ('public', 'private')),
  owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  member_count integer DEFAULT 1,
  post_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT valid_community_name CHECK (name ~* '^[a-zA-Z0-9_]{3,20}$')
);

-- Memberships table for community access
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  joined_at timestamptz DEFAULT now(),
  
  UNIQUE(user_id, community_id)
);

-- Anonymous aliases for privacy
CREATE TABLE IF NOT EXISTS anon_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  alias_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  
  UNIQUE(user_id, community_id)
);

-- Posts table with moderation support
CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  author_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  is_anonymous boolean DEFAULT false,
  is_approved boolean DEFAULT false,
  is_removed boolean DEFAULT false,
  moderation_status text DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged')),
  toxicity_score real DEFAULT 0.0,
  vote_score integer DEFAULT 0,
  comment_count integer DEFAULT 0,
  hot_score real DEFAULT 0.0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid REFERENCES profiles(id)
);

-- Comments table with nested support
CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  author_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  is_anonymous boolean DEFAULT false,
  is_approved boolean DEFAULT false,
  is_removed boolean DEFAULT false,
  moderation_status text DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged')),
  toxicity_score real DEFAULT 0.0,
  vote_score integer DEFAULT 0,
  depth integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid REFERENCES profiles(id)
);

-- Votes table for posts and comments
CREATE TABLE IF NOT EXISTS votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id uuid REFERENCES posts(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  vote_type text NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at timestamptz DEFAULT now(),
  
  UNIQUE(user_id, post_id),
  UNIQUE(user_id, comment_id),
  CHECK ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL))
);

-- Moderation logs for audit trail
CREATE TABLE IF NOT EXISTS moderation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('post', 'comment', 'user')),
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'reject', 'remove', 'flag', 'ban', 'unban')),
  reason text,
  automated boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Trending topics for search
CREATE TABLE IF NOT EXISTS trending_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text UNIQUE NOT NULL,
  frequency integer DEFAULT 1,
  last_updated timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE anon_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_topics ENABLE ROW LEVEL SECURITY;

-- RLS Policies for profiles
CREATE POLICY "Public profiles are viewable by everyone"
  ON profiles FOR SELECT
  USING (true);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- RLS Policies for communities
CREATE POLICY "Public communities are viewable by everyone"
  ON communities FOR SELECT
  USING (privacy_type = 'public' OR auth.uid() IN (
    SELECT user_id FROM memberships 
    WHERE community_id = communities.id AND status = 'approved'
  ));

CREATE POLICY "Users can create communities"
  ON communities FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = owner_id);

-- RLS Policies for memberships
CREATE POLICY "Users can view their own memberships"
  ON memberships FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can request membership"
  ON memberships FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for posts
CREATE POLICY "Approved posts are viewable by community members"
  ON posts FOR SELECT
  USING (
    is_approved = true 
    AND NOT is_removed 
    AND (
      community_id IN (
        SELECT community_id FROM memberships 
        WHERE user_id = auth.uid() AND status = 'approved'
      )
      OR community_id IN (
        SELECT id FROM communities WHERE privacy_type = 'public'
      )
    )
  );

CREATE POLICY "Users can create posts in joined communities"
  ON posts FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = author_id 
    AND community_id IN (
      SELECT community_id FROM memberships 
      WHERE user_id = auth.uid() AND status = 'approved'
    )
  );

-- RLS Policies for comments
CREATE POLICY "Approved comments are viewable with their posts"
  ON comments FOR SELECT
  USING (
    is_approved = true 
    AND NOT is_removed 
    AND post_id IN (
      SELECT id FROM posts WHERE is_approved = true AND NOT is_removed
    )
  );

CREATE POLICY "Users can comment on viewable posts"
  ON comments FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = author_id 
    AND post_id IN (
      SELECT id FROM posts WHERE is_approved = true AND NOT is_removed
    )
  );

-- RLS Policies for votes
CREATE POLICY "Users can view all votes"
  ON votes FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can vote on viewable content"
  ON votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own votes"
  ON votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- RLS Policies for anon_aliases
CREATE POLICY "Users can view their own aliases"
  ON anon_aliases FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own aliases"
  ON anon_aliases FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for moderation_logs (moderators only)
CREATE POLICY "Moderators can view moderation logs"
  ON moderation_logs FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM profiles 
      WHERE is_moderator = true OR is_admin = true
    )
  );

-- RLS Policies for trending_topics
CREATE POLICY "Everyone can view trending topics"
  ON trending_topics FOR SELECT
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_posts_community_approved ON posts(community_id, is_approved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(hot_score DESC) WHERE is_approved = true;
CREATE INDEX IF NOT EXISTS idx_comments_post_approved ON comments(post_id, is_approved, created_at);
CREATE INDEX IF NOT EXISTS idx_memberships_user_status ON memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
CREATE INDEX IF NOT EXISTS idx_votes_comment ON votes(comment_id);
CREATE INDEX IF NOT EXISTS idx_posts_search ON posts USING gin(to_tsvector('english', title || ' ' || content));
CREATE INDEX IF NOT EXISTS idx_communities_search ON communities USING gin(to_tsvector('english', name || ' ' || description));

-- Function to generate anonymous aliases
CREATE OR REPLACE FUNCTION generate_anon_alias(user_uuid uuid, community_uuid uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alias_name text;
  counter integer := 1;
BEGIN
  -- Generate base alias
  alias_name := 'Anon-' || substring(md5(user_uuid::text || community_uuid::text) from 1 for 6);
  
  -- Ensure uniqueness within community
  WHILE EXISTS (
    SELECT 1 FROM anon_aliases 
    WHERE community_id = community_uuid AND alias_name = alias_name
  ) LOOP
    alias_name := 'Anon-' || substring(md5(user_uuid::text || community_uuid::text || counter::text) from 1 for 6);
    counter := counter + 1;
  END LOOP;
  
  RETURN alias_name;
END;
$$;

-- Function to update hot scores
CREATE OR REPLACE FUNCTION update_hot_score()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE posts 
  SET hot_score = (
    vote_score + comment_count * 0.5
  ) * (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0))
  WHERE is_approved = true AND NOT is_removed;
END;
$$;

-- Trigger to create profile on user signup
CREATE OR REPLACE FUNCTION create_profile_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

-- Create trigger for profile creation
DROP TRIGGER IF EXISTS create_profile_trigger ON auth.users;
CREATE TRIGGER create_profile_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_profile_for_user();

-- Function to update community member count
CREATE OR REPLACE FUNCTION update_community_member_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN
      UPDATE communities 
      SET member_count = member_count + 1 
      WHERE id = NEW.community_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status != 'approved' AND NEW.status = 'approved' THEN
      UPDATE communities 
      SET member_count = member_count + 1 
      WHERE id = NEW.community_id;
    ELSIF OLD.status = 'approved' AND NEW.status != 'approved' THEN
      UPDATE communities 
      SET member_count = member_count - 1 
      WHERE id = NEW.community_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      UPDATE communities 
      SET member_count = member_count - 1 
      WHERE id = OLD.community_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

-- Create trigger for member count updates
CREATE TRIGGER update_community_member_count_trigger
  AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_community_member_count();

-- Function to update post comment count
CREATE OR REPLACE FUNCTION update_post_comment_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_approved THEN
      UPDATE posts 
      SET comment_count = comment_count + 1 
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.is_approved != NEW.is_approved THEN
      IF NEW.is_approved THEN
        UPDATE posts 
        SET comment_count = comment_count + 1 
        WHERE id = NEW.post_id;
      ELSE
        UPDATE posts 
        SET comment_count = comment_count - 1 
        WHERE id = NEW.post_id;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.is_approved THEN
      UPDATE posts 
      SET comment_count = comment_count - 1 
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

-- Create trigger for comment count updates
CREATE TRIGGER update_post_comment_count_trigger
  AFTER INSERT OR UPDATE OR DELETE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION update_post_comment_count();