import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface CreateCommentRequest {
  action: 'create';
  content: string;
  post_id: string;
  parent_id?: string;
  is_anonymous: boolean;
}

interface GetCommentsRequest {
  action: 'get';
  post_id: string;
}

type CommentRequest = CreateCommentRequest | GetCommentsRequest;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const requestData: CommentRequest = await req.json();
    
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
      return await handleCreateComment(requestData, user.id);
    } else if (requestData.action === 'get') {
      return await handleGetComments(requestData, user.id);
    }

    throw new Error('Invalid action');
  } catch (error) {
    console.error('Comments API error:', error);
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

async function handleCreateComment(data: CreateCommentRequest, userId: string) {
  const { content, post_id, parent_id, is_anonymous } = data;

  // Validate input
  if (!content.trim() || !post_id) {
    throw new Error('Content and post ID are required');
  }

  if (content.length > 5000) {
    throw new Error('Comment too long (max 5000 characters)');
  }

  // Check if post exists and user can access it
  const { data: post } = await supabase
    .from('posts_with_stats')
    .select('id, community_id')
    .eq('id', post_id)
    .single();

  if (!post) {
    throw new Error('Post not found or not accessible');
  }

  // Check if user is member of the community
  const { data: membership } = await supabase
    .from('memberships')
    .select('status')
    .eq('user_id', userId)
    .eq('community_id', post.community_id)
    .single();

  if (!membership || membership.status !== 'approved') {
    throw new Error('You must be a member of this community to comment');
  }

  // Calculate comment depth if it's a reply
  let depth = 0;
  if (parent_id) {
    const { data: parentComment } = await supabase
      .from('comments')
      .select('depth')
      .eq('id', parent_id)
      .single();

    if (!parentComment) {
      throw new Error('Parent comment not found');
    }

    depth = parentComment.depth + 1;
    
    // Limit nesting depth
    if (depth > 5) {
      throw new Error('Maximum comment nesting depth reached');
    }
  }

  // Create the comment
  const { data: comment, error: commentError } = await supabase
    .from('comments')
    .insert({
      content: content.trim(),
      author_id: userId,
      post_id,
      parent_id: parent_id || null,
      is_anonymous,
      depth,
      moderation_status: 'pending',
    })
    .select()
    .single();

  if (commentError) throw commentError;

  // Generate anonymous alias if needed
  if (is_anonymous) {
    await generateAnonymousAlias(userId, post.community_id);
  }

  // Trigger moderation check
  await triggerModerationCheck(comment.id, 'comment', content);

  return new Response(
    JSON.stringify({
      success: true,
      comment_id: comment.id,
      message: 'Comment created and submitted for moderation',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

async function handleGetComments(data: GetCommentsRequest, userId: string) {
  const { post_id } = data;

  // Get comments with author info (respecting anonymity)
  const { data: comments, error } = await supabase
    .from('comments')
    .select(`
      id,
      content,
      author_id,
      parent_id,
      is_anonymous,
      vote_score,
      depth,
      created_at,
      profiles!comments_author_id_fkey(display_name),
      anon_aliases!left(alias_name)
    `)
    .eq('post_id', post_id)
    .eq('is_approved', true)
    .eq('is_removed', false)
    .order('created_at', { ascending: true });

  if (error) throw error;

  // Format comments with proper author names
  const formattedComments = comments?.map(comment => ({
    ...comment,
    author_display_name: comment.is_anonymous 
      ? (comment.anon_aliases?.alias_name || 'Anonymous')
      : comment.profiles?.display_name,
  })) || [];

  return new Response(
    JSON.stringify({
      success: true,
      comments: formattedComments,
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