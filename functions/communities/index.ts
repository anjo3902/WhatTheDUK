import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface CreateCommunityRequest {
  action: 'create';
  name: string;
  description: string;
  privacy_type: 'public' | 'private';
}

interface JoinCommunityRequest {
  action: 'join';
  community_id: string;
}

interface ApproveMembershipRequest {
  action: 'approve_membership';
  membership_id: string;
  approve: boolean;
}

type CommunityRequest = CreateCommunityRequest | JoinCommunityRequest | ApproveMembershipRequest;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const requestData: CommunityRequest = await req.json();
    
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

    switch (requestData.action) {
      case 'create':
        return await handleCreateCommunity(requestData, user.id);
      case 'join':
        return await handleJoinCommunity(requestData, user.id);
      case 'approve_membership':
        return await handleApproveMembership(requestData, user.id);
      default:
        throw new Error('Invalid action');
    }
  } catch (error) {
    console.error('Communities API error:', error);
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

async function handleCreateCommunity(data: CreateCommunityRequest, userId: string) {
  const { name, description, privacy_type } = data;

  // Validate input
  if (!name.trim() || !description.trim()) {
    throw new Error('Community name and description are required');
  }

  if (name.length < 3 || name.length > 20) {
    throw new Error('Community name must be between 3 and 20 characters');
  }

  if (description.length > 500) {
    throw new Error('Description must be less than 500 characters');
  }

  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('Community name can only contain letters, numbers, and underscores');
  }

  // Check for existing community name
  const { data: existingCommunity } = await supabase
    .from('communities')
    .select('id')
    .eq('name', name.toLowerCase())
    .single();

  if (existingCommunity) {
    throw new Error('A community with this name already exists');
  }

  // Create the community
  const { data: community, error: communityError } = await supabase
    .from('communities')
    .insert({
      name: name.toLowerCase(),
      description: description.trim(),
      privacy_type,
      owner_id: userId,
    })
    .select()
    .single();

  if (communityError) throw communityError;

  // Auto-approve owner as member
  const { error: membershipError } = await supabase
    .from('memberships')
    .insert({
      user_id: userId,
      community_id: community.id,
      role: 'admin',
      status: 'approved',
    });

  if (membershipError) throw membershipError;

  return new Response(
    JSON.stringify({
      success: true,
      community_id: community.id,
      message: 'Community created successfully',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

async function handleJoinCommunity(data: JoinCommunityRequest, userId: string) {
  const { community_id } = data;

  // Check if community exists
  const { data: community } = await supabase
    .from('communities')
    .select('privacy_type')
    .eq('id', community_id)
    .single();

  if (!community) {
    throw new Error('Community not found');
  }

  // Check if already a member
  const { data: existingMembership } = await supabase
    .from('memberships')
    .select('status')
    .eq('user_id', userId)
    .eq('community_id', community_id)
    .single();

  if (existingMembership) {
    if (existingMembership.status === 'approved') {
      throw new Error('You are already a member of this community');
    } else if (existingMembership.status === 'pending') {
      throw new Error('Your membership request is already pending approval');
    }
  }

  // Determine membership status based on privacy
  const status = community.privacy_type === 'public' ? 'approved' : 'pending';

  // Create or update membership
  const { error: membershipError } = await supabase
    .from('memberships')
    .upsert({
      user_id: userId,
      community_id,
      status,
      role: 'member',
    });

  if (membershipError) throw membershipError;

  const message = status === 'approved' 
    ? 'Successfully joined the community!'
    : 'Membership request submitted for approval';

  return new Response(
    JSON.stringify({
      success: true,
      status,
      message,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

async function handleApproveMembership(data: ApproveMembershipRequest, userId: string) {
  const { membership_id, approve } = data;

  // Get membership details
  const { data: membership } = await supabase
    .from('memberships')
    .select(`
      *,
      communities!inner(owner_id)
    `)
    .eq('id', membership_id)
    .single();

  if (!membership) {
    throw new Error('Membership request not found');
  }

  // Check if user has permission to approve (community owner or admin)
  const { data: userMembership } = await supabase
    .from('memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('community_id', membership.community_id)
    .eq('status', 'approved')
    .single();

  const isOwner = membership.communities.owner_id === userId;
  const isAdmin = userMembership?.role === 'admin';

  if (!isOwner && !isAdmin) {
    throw new Error('You do not have permission to approve memberships');
  }

  // Update membership status
  const newStatus = approve ? 'approved' : 'rejected';
  const { error: updateError } = await supabase
    .from('memberships')
    .update({ status: newStatus })
    .eq('id', membership_id);

  if (updateError) throw updateError;

  return new Response(
    JSON.stringify({
      success: true,
      message: `Membership ${approve ? 'approved' : 'rejected'} successfully`,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}