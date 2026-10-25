"""speech results

Revision ID: c7a19f3e5d21
Revises: b41c2d7e9a10
Create Date: 2026-10-25 18:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c7a19f3e5d21'
down_revision: Union[str, None] = 'b41c2d7e9a10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('speech_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('word', sa.String(length=100), nullable=False),
    sa.Column('score', sa.Float(), nullable=False),
    sa.Column('heard', sa.String(length=200), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('speech_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_speech_results_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('speech_results', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_speech_results_user_id'))

    op.drop_table('speech_results')
