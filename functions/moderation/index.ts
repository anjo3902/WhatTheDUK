import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface ModerationRequest {
  content: string;
  content_type: 'post' | 'comment';
  content_id: string;
  author_id: string;
}

interface ToxicityResult {
  score: number;
  is_toxic: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { content, content_type, content_id, author_id }: ModerationRequest = await req.json();

    // Step 1: Basic profanity filter (regex-based)
    const profanityResult = await checkProfanity(content);
    
    // Step 2: Toxicity scoring using mock AI model
    const toxicityResult = await checkToxicity(content);

    // Step 3: Determine moderation action
    const moderationDecision = decideModerationAction(profanityResult, toxicityResult);

    // Step 4: Update content status
    await updateContentStatus(content_type, content_id, moderationDecision, toxicityResult.score);

    // Step 5: Log moderation action
    await logModerationAction(content_type, content_id, moderationDecision, author_id);

    return new Response(
      JSON.stringify({
        decision: moderationDecision.action,
        toxicity_score: toxicityResult.score,
        auto_approved: moderationDecision.action === 'approve',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error('Moderation error:', error);
    return new Response(
      JSON.stringify({
        error: 'Moderation check failed',
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

async function checkProfanity(content: string): Promise<{ hasProfanity: boolean; words: string[] }> {
  // Basic profanity word list (expand as needed)
  const profanityWords = [
    'spam', 'scam', 'fake', 'fraud', 'cheat', 'hack', 'illegal'
  ];
  
  const contentLower = content.toLowerCase();
  const foundWords = profanityWords.filter(word => contentLower.includes(word));
  
  return {
    hasProfanity: foundWords.length > 0,
    words: foundWords,
  };
}

async function checkToxicity(content: string): Promise<ToxicityResult> {
  // Mock toxicity detection (replace with actual open-source model)
  // In production, use Hugging Face Transformers.js or similar
  
  const suspiciousPatterns = [
    /\b(hate|attack|threat|violence)\b/i,
    /[A-Z]{10,}/, // All caps (shouting)
    /(.)\1{4,}/, // Repeated characters
    /\b\d{10,}\b/, // Phone numbers
    /https?:\/\/[^\s]+/g, // URLs (potential spam)
  ];

  let toxicityScore = 0;
  
  suspiciousPatterns.forEach(pattern => {
    if (pattern.test(content)) {
      toxicityScore += 0.2;
    }
  });

  // Add length-based scoring
  if (content.length < 10) toxicityScore += 0.1;
  if (content.length > 2000) toxicityScore += 0.1;

  // Simulate AI model scoring
  toxicityScore = Math.min(toxicityScore + Math.random() * 0.1, 1.0);

  return {
    score: Math.round(toxicityScore * 100) / 100,
    is_toxic: toxicityScore > 0.7,
  };
}

interface ModerationDecision {
  action: 'approve' | 'flag' | 'reject';
  reason: string;
}

function decideModerationAction(
  profanityResult: { hasProfanity: boolean; words: string[] },
  toxicityResult: ToxicityResult
): ModerationDecision {
  // Auto-reject if high toxicity or profanity
  if (toxicityResult.score > 0.8 || profanityResult.hasProfanity) {
    return {
      action: 'reject',
      reason: profanityResult.hasProfanity 
        ? `Contains prohibited words: ${profanityResult.words.join(', ')}`
        : 'High toxicity score detected',
    };
  }

  // Flag for manual review if moderate toxicity
  if (toxicityResult.score > 0.5) {
    return {
      action: 'flag',
      reason: 'Moderate toxicity score - requires manual review',
    };
  }

  // Auto-approve if low toxicity
  return {
    action: 'approve',
    reason: 'Content passed automated moderation checks',
  };
}

async function updateContentStatus(
  contentType: string,
  contentId: string,
  decision: ModerationDecision,
  toxicityScore: number
) {
  const table = contentType === 'post' ? 'posts' : 'comments';
  
  const updateData: any = {
    toxicity_score: toxicityScore,
    updated_at: new Date().toISOString(),
  };

  switch (decision.action) {
    case 'approve':
      updateData.is_approved = true;
      updateData.moderation_status = 'approved';
      updateData.approved_at = new Date().toISOString();
      break;
    case 'flag':
      updateData.moderation_status = 'flagged';
      break;
    case 'reject':
      updateData.moderation_status = 'rejected';
      updateData.is_removed = true;
      break;
  }

  const { error } = await supabase
    .from(table)
    .update(updateData)
    .eq('id', contentId);

  if (error) throw error;
}

async function logModerationAction(
  contentType: string,
  contentId: string,
  decision: ModerationDecision,
  authorId: string
) {
  const { error } = await supabase
    .from('moderation_logs')
    .insert({
      moderator_id: 'system', // Use system ID for automated actions
      target_type: contentType,
      target_id: contentId,
      action: decision.action,
      reason: decision.reason,
      automated: true,
    });

  if (error) {
    console.error('Failed to log moderation action:', error);
  }
}