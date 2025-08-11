import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface SearchRequest {
  query: string;
  type: 'all' | 'posts' | 'communities';
  limit?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { query, type = 'all', limit = 20 }: SearchRequest = await req.json();
    
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

    if (!query.trim()) {
      throw new Error('Search query is required');
    }

    const results = await performSearch(query.trim(), type, user.id, limit);

    // Update trending topics
    await updateTrendingTopics(query.trim());

    return new Response(
      JSON.stringify({
        success: true,
        results,
        query: query.trim(),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error('Search API error:', error);
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

async function performSearch(query: string, type: string, userId: string, limit: number) {
  const results: any[] = [];

  if (type === 'all' || type === 'posts') {
    // Search posts
    const { data: posts, error: postsError } = await supabase
      .from('posts_with_stats')
      .select('*')
      .textSearch('title', query, { 
        type: 'websearch',
        config: 'english'
      })
      .eq('is_approved', true)
      .limit(Math.floor(limit / 2));

    if (postsError) throw postsError;

    // Also search by content
    const { data: contentPosts, error: contentError } = await supabase
      .from('posts_with_stats')
      .select('*')
      .textSearch('content', query, { 
        type: 'websearch',
        config: 'english'
      })
      .eq('is_approved', true)
      .limit(Math.floor(limit / 2));

    if (contentError) throw contentError;

    // Combine and deduplicate posts
    const allPosts = [...(posts || []), ...(contentPosts || [])];
    const uniquePosts = allPosts.filter((post, index, self) => 
      index === self.findIndex(p => p.id === post.id)
    );

    uniquePosts.forEach(post => {
      results.push({
        type: 'post',
        data: post,
        relevance: calculateRelevance(query, post.title + ' ' + post.content),
      });
    });
  }

  if (type === 'all' || type === 'communities') {
    // Search communities
    const { data: communities, error: communitiesError } = await supabase
      .from('communities_with_membership')
      .select('*')
      .or(`name.ilike.%${query}%,description.ilike.%${query}%`)
      .eq('is_active', true)
      .limit(limit);

    if (communitiesError) throw communitiesError;

    communities?.forEach(community => {
      results.push({
        type: 'community',
        data: community,
        relevance: calculateRelevance(query, community.name + ' ' + community.description),
      });
    });
  }

  // Sort by relevance
  results.sort((a, b) => b.relevance - a.relevance);

  return results.slice(0, limit);
}

function calculateRelevance(query: string, content: string): number {
  const queryWords = query.toLowerCase().split(/\s+/);
  const contentLower = content.toLowerCase();
  
  let score = 0;
  
  queryWords.forEach(word => {
    if (contentLower.includes(word)) {
      score += 1;
      
      // Bonus for exact word matches
      const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = contentLower.match(wordRegex);
      if (matches) {
        score += matches.length * 0.5;
      }
    }
  });

  return score;
}

async function updateTrendingTopics(query: string) {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && word.length < 20);

  for (const word of words.slice(0, 3)) {
    try {
      await supabase
        .from('trending_topics')
        .upsert({
          topic: word,
          frequency: 1,
          last_updated: new Date().toISOString(),
        }, {
          onConflict: 'topic',
        });
    } catch (error) {
      console.error('Failed to update trending topic:', error);
    }
  }
}