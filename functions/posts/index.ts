import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface CreatePostRequest {
  action: 'create';
  title: string;
  content: string;
  community_id: string;
  is_anonymous: boolean;
}

interface VoteRequest {
  action: 'vote';
  post_id: string;
  vote_type: 'up' | 'down' | null;
}

type PostRequest = CreatePostRequest | VoteRequest;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const requestData: PostRequest = await req.json();
    
    // Get user from JWT token
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      throw new Error('Invalid authentication');
    }

    if (requestData.action === 'create') {
      return await handleCreatePost(requestData, user.id);
    } else if (requestData.action === 'vote') {
      return await handleVotePost(requestData, user.id);
    }

    throw new Error('Invalid action');
  } catch (error) {
    console.error('Posts API error:', error);
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal server error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  }
});

async function handleCreatePost(data: CreatePostRequest, userId: string) {
  const { title, content, community_id, is_anonymous } = data;

  // Validate input
  if (!title.trim() || !content.trim() || !community_id) {
    throw new Error('Missing required fields');
  }

  if (title.length > 300 || content.length > 10000) {
    throw new Error('Content too long');
  }

  // Check if user is member of community
  const { data: membership } = await supabase
    .from('memberships')
    .select('status')
    .eq('user_id', userId)
    .eq('community_id', community_id)
    .single();

  if (!membership || membership.status !== 'approved') {
    throw new Error('You must be a member of this community to post');
  }

  // Create the post
  const { data: post, error: postError } = await supabase
    .from('posts')
    .insert({
      title: title.trim(),
      content: content.trim(),
      author_id: userId,
      community_id,
      is_anonymous,
      moderation_status: 'pending',
    })
    .select()
    .single();

  if (postError) throw postError;

  // Generate anonymous alias if needed
  if (is_anonymous) {
    await generateAnonymousAlias(userId, community_id);
  }

  // Trigger moderation check
  await triggerModerationCheck(post.id, 'post', content);

  // Update trending topics
  await updateTrendingTopics(title + ' ' + content);

  return new Response(
    JSON.stringify({
      success: true,
      post_id: post.id,
      message: 'Post created and submitted for moderation',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

async function handleVotePost(data: VoteRequest, userId: string) {
  const { post_id, vote_type } = data;

  if (vote_type === null) {
    // Remove existing vote
    const { error } = await supabase
      .from('votes')
      .delete()
      .eq('user_id', userId)
      .eq('post_id', post_id);

    if (error) throw error;
  } else {
    // Upsert vote
    const { error } = await supabase
      .from('votes')
      .upsert({
        user_id: userId,
        post_id,
        vote_type,
      });

    if (error) throw error;
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: 'Vote updated successfully',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

async function generateAnonymousAlias(userId: string, communityId: string) {
  const { data: existingAlias } = await supabase
    .from('anon_aliases')
    .select('alias_name')
    .eq('user_id', userId)
    .eq('community_id', communityId)
    .single();

  if (!existingAlias) {
    const aliasName = 'Anon-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    await supabase
      .from('anon_aliases')
      .insert({
        user_id: userId,
        community_id: communityId,
        alias_name: aliasName,
      });
  }
}

async function triggerModerationCheck(contentId: string, contentType: string, content: string) {
  try {
    await supabase.functions.invoke('moderation', {
      body: {
        content,
        content_type: contentType,
        content_id: contentId,
        author_id: 'system',
      },
    });
  } catch (error) {
    console.error('Failed to trigger moderation check:', error);
  }
}

async function updateTrendingTopics(content: string) {
  // Extract potential trending words (simple implementation)
  const words = content
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3 && word.length < 20);

  for (const word of words.slice(0, 5)) { // Limit to top 5 words
    await supabase
      .from('trending_topics')
      .upsert({
        topic: word,
        frequency: 1,
        last_updated: new Date().toISOString(),
      }, {
        onConflict: 'topic',
        ignoreDuplicates: false,
      });
  }
}