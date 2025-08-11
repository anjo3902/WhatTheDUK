import { corsHeaders } from '../_shared/cors.ts';

interface AuthRequest {
  email: string;
  display_name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { email, display_name }: AuthRequest = await req.json();

    // Validate DUK email domain
    const emailRegex = /^[^@\s]+@duk\.ac\.in$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid email domain. Only @duk.ac.in email addresses are allowed.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    // Validate display name
    if (!display_name || display_name.trim().length < 2 || display_name.trim().length > 50) {
      return new Response(
        JSON.stringify({
          error: 'Display name must be between 2 and 50 characters.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        message: 'Email and display name are valid.',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Invalid request format.',
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  }
});