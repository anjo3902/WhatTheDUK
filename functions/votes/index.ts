import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface VoteRequest {
  post_id?: string;
  comment_id?: string;
  vote_type: 'up' | 'down' | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { post_id, comment_id, vote_type }: VoteRequest = await req.json();
    
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

    // Validate input
    if ((!post_id && !comment_id) || (post_id && comment_id)) {
      throw new Error('Must specify either post_id or comment_id, but not both');
    }

    if (vote_type && !['up', 'down'].includes(vote_type)) {
      throw new Error('Invalid vote type');
    }

    // Check if content exists and user can access it
    if (post_id) {
      const { data: post } = await supabase
        .from('posts_with_stats')
        .select('id')
        .eq('id', post_id)
        .single();

      if (!post) {
        throw new Error('Post not found or not accessible');
      }
    }

    if (comment_id) {
      const { data: comment } = await supabase
        .from('comments')
        .select('id')
        .eq('id', comment_id)
        .eq('is_approved', true)
        .eq('is_removed', false)
        .single();

      if (!comment) {
        throw new Error('Comment not found or not accessible');
      }
    }

    // Handle vote
    if (vote_type === null) {
      // Remove existing vote
      const { error } = await supabase
        .from('votes')
        .delete()
        .eq('user_id', user.id)
        .eq(post_id ? 'post_id' : 'comment_id', post_id || comment_id);

      if (error) throw error;
    } else {
      // Upsert vote
      const voteData: any = {
        user_id: user.id,
        vote_type,
      };

      if (post_id) {
        voteData.post_id = post_id;
      } else {
        voteData.comment_id = comment_id;
      }

      const { error } = await supabase
        .from('votes')
        .upsert(voteData, {
          onConflict: post_id ? 'user_id,post_id' : 'user_id,comment_id',
        });

      if (error) throw error;
    }

    // Get updated vote score
    const targetId = post_id || comment_id;
    const targetType = post_id ? 'post' : 'comment';
    
    const { data: voteScore } = await supabase.rpc('calculate_vote_score', {
      target_id: targetId,
      target_type: targetType,
    });

    return new Response(
      JSON.stringify({
        success: true,
        vote_score: voteScore,
        message: 'Vote updated successfully',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error('Votes API error:', error);
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